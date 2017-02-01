'use strict'

var mime = require('lighter-mime')
var tcp = require('lighter-tcp')
var Type = require('lighter-type')
var Cache = require('lighter-lru-cache')
// var multipart = require('./multipart')
var doNothing = function () {}

// Maximum number of bytes we can receive (to avoid storage attacks).
var MAX_BYTES = 1e8 // ~100MB.

/**
 * Turn a string into a RegExp pattern if it has asterisks.
 */
function patternify (str, start, end) {
  if (typeof str === 'string') {
    str = str.toLowerCase()
    if (str.indexOf('*') > -1) {
      return new RegExp(start + str
        .replace(/\*/g, '@')
        .replace(/([^\d\w_-])/gi, '\\$1')
        .replace(/\\@/g, '.*') + end, 'i')
    }
  }
  return str
}

var codes = {
  100: 'Continue',
  101: 'Switching Protocols',
  102: 'Processing',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  207: 'Multi-Status',
  208: 'Already Reported',
  226: 'IM Used',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  305: 'Use Proxy',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  418: "I'm a teapot",
  421: 'Misdirected Request',
  422: 'Unprocessable Entity',
  423: 'Locked',
  424: 'Failed Dependency',
  425: 'Unordered Collection',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
  506: 'Variant Also Negotiates',
  507: 'Insufficient Storage',
  508: 'Loop Detected',
  509: 'Bandwidth Limit Exceeded',
  510: 'Not Extended',
  511: 'Network Authentication Required'
}

var heads = {}
for (var code in codes) {
  heads[code] = 'HTTP/1.1 ' + code + ' ' + codes[code]
}

/**
 * A Server object handles HTTP connections.
 *
 * @param  {Object}  options  An object containing any of the following...
 *                              * port: The port to listen on (default: 8080).
 *
 * @return {Object}           An HTTP server.
 */
var Server = exports.Server = tcp.Server.extend(function Server (options) {
  var transfer = Transfer.prototype
  tcp.Server.call(this, options)
  this.routes = {
    GET: {'/BEAM': transfer._beamGet},
    POST: {'/BEAM': transfer._beamPost}
  }
  this.steps = []
  this.views = {}
  this.beams = new Beams(this)
  this.concurrent = 0
}, {

  /**
   * Consumers see that this server uses transfer instead of request & response.
   */
  _isLighterHttp: true,

  /**
   * Add a function to handle a specific HTTP method and URL path.
   */
  _add: function _add (method, path, fn) {
    var routes = this.routes
    var parts = path.split('/')
    parts[0] = method
    method = method.toUpperCase()
    path = patternify(path, '^', '$')
    var map = routes[method] = routes[method] || []

    // Map a pattern with "@", and add to the list of patterns.
    if (path instanceof RegExp) {
      map.push(path)
      map['@' + path] = fn
    // Or map a path directly.
    } else {
      map[path] = fn
    }
    return this
  },

  get: function get (path, fn) {
    return this._add('GET', path, fn)
  },

  post: function post (path, fn) {
    return this._add('POST', path, fn)
  },

  put: function put (path, fn) {
    return this._add('PUT', path, fn)
  },

  delete: function _delete (path, fn) {
    return this._add('DELETE', path, fn)
  },

  /**
   * Add a step, with an optional path.
   */
  use: function use (path, fn, priority) {
    var step
    if (typeof path === 'function') {
      step = path
    } else {
      step = {
        path: patternify(path, '^', ''),
        fn: fn
      }
    }
    this.steps.push(step)
    return this
  },

  /**
   * Remove a step, regardless of path.
   */
  unuse: function unuse (fn) {
    var steps = this.steps
    for (var i = 0; i < steps.length; i++) {
      var step = steps[i]
      if ((fn === step) || (fn === step.fn)) {
        steps.splice(i--, 1)
      }
    }
  },

  beam: function beam (name, fn) {
    this.on('beam:' + name, fn)
  }

}, {

  Events: tcp.Server.Events.extend(function Events () {}, {
    connection: function (transfer) {
      // Ignore hangups.
      transfer.on('error', doNothing)
    }
  })

})

var Transfer = exports.Transfer = tcp.Socket.extend({

  _init: function _init () {
    this.server.concurrent++
    this._start = Date.now()
    this._transferring = true
    this._headerSent = false
    this.request = {}
    this.response = {}
    this._events = new Transfer.Events()
    this.state = new Transfer.State()
    this._step = 0
    this.status = 200
    this.body = ''
  },

  _getHeader: function _getHeader () {
    var request = this.request
    var response = this.response
    var head = heads[this.status]
    head += '\r\nDate: ' + (new Date()).toUTCString()
    if (request.connection === 'keep-alive') {
      head += '\r\nConnection: keep-alive'
    }
    if (!response['Content-Type']) {
      var extension = this.path.replace(/^.*\./, '')
      head += '\r\nContent-Type: ' + (mime[extension] || 'text/html')
    }
    for (var key in response) {
      head += '\r\n' + key + ': ' + response[key]
    }
    return head + '\r\n\r\n'
  },

  next: function next () {
    var ok
    do {
      var fn = this.server.steps[this._step++]
      if (!fn) {
        return this._finish()
      }
      ok = fn.call(this)
    } while (ok === true)
  },

  _finish: function _finish () {
    var method = this.method
    var path = this.path
    var routes = this.server.routes

    // TODO: Support CONNECT/OPTIONS/TRACE.
    if (method === 'HEAD') {
      method = 'GET'
      this.write = doNothing
    }
    var map = routes[method] || routes.GET
    var fn = map[path]

    // If the path didn't map to a route, iterate over wildcard routes.
    if (!fn) {
      for (var i = 0, l = map.length; i < l; i++) {
        var p = map[i]
        if (p.test(path)) {
          fn = map['@' + p]
          break
        }
      }
    }

    if (fn) {
      if (method[0] === 'P') {
        // var maxBytes = fn._MAX_BYTES || MAX_BYTES
        if (/multipart/.test(this.request['content-type'])) {
          this.multipart = {}
          fn.call(this)
          // multipart(this, maxBytes)
        } else {
          // TODO: Support streaming.
          fn.call(this)
        }
      } else {
        fn.call(this)
      }
    } else {
      this.status = 404
      this.end('<h1>Page Not Found</h1>')
    }
  },

  end: function end (text) {
    if (!this._headerSent) {
      this.response['Content-Length'] = text.length
    }
    this.write(text || '')
    this._transferring = false
    if (!--this.server.concurrent) {
      this.emit('idle')
    }
  },

  /**
   * Render a view with a given name and optional data.
   *
   * @param  {String} name  The name of the view to render.
   * @param  {Object} data  Data to pass to the view function.
   */
  view: function (name, data) {
    var views = this.server.views
    if (!views[name]) {
      throw new Error('View "' + name + '" not found.')
    }
    var state = this.state
    if (data) {
      for (var key in data) {
        state[key] = data[key]
      }
    }
    var output = state.isJson ? JSON.stringify(state) : views[name](state)
    this.end(output)
  },

  beam: function (name, data) {
    this._beamQueue.push([name, data])
    if (!this._headerSent) {
      this.response['Access-Control-Allow-Origin'] = '*'
      this.response['Content-Type'] = 'text/json'
      this.end(JSON.stringify(this._beamQueue))
      this._beamQueue = []
    }
  },

  _beamTimeout: 3e4,

  _beamReset: function _beamReset () {
    var self = this
    clearTimeout(this._beamTimer)
    this._beamTimer = setTimeout(function () {
      self.emit('beam:timeout')
    }, this._beamTimeout)
  },

  _beamGet: function _beamGet () {
    var id = this.query.id
    var beams = this.server.beams
    var beam = beams.get(id)
    if (!beam || (id !== beam.id)) {
      id = this.id = 'B' + (beams.n++).toString(36)
      beams.set(id, this)
      this._beamQueue = []
      this._beamReset()
      this.beam('connect', {id: id})
    }
  },

  _beamPost: function _beamPost () {
    var body = this.body
    try {
      var list = JSON.parse(body)
      for (var i = 0, l = list.length; i < l; i++) {
        var data = list[i]
        this.server.emit('beam:' + data[1], this, data[2], data[0])
        this.send('OK')
      }
    } catch (e) {
      // Couldn't parse, so call with exactly what we received.
    }
  },

  /**
   * Send a JSON response.
   *
   * @param  {Object} json  Response data to send.
   * @return {Object}       Self.
   */
  send: function send (json) {
    this.response['Access-Control-Allow-Origin'] = '*'
    this.response['Content-Type'] = 'text/json'
    this.end('OK')
    return this
  }

}, {

  Events: tcp.Server.Events.extend(function Events () {}, {
    data: function (chunk) {
      // Start or restart a transfer.
      if (!this._transferring) {
        this._init()
      }

      if (this.body) {
        this.body += chunk
      } else {
        var lines = chunk.toString().split('\r\n')
        var count = lines.length
        for (var index = 0; index < count; index++) {
          var line = lines[index]
          // Continue until there's an empty line.
          if (line) {
            // Treat each line after the 1st as a header.
            if (index) {
              var colon = line.indexOf(':')
              var name = line.substr(0, colon).toLowerCase()
              var value = line.substr(colon + 1).trim()
              this.request[name] = value
            } else {
              var parts = line.split(/\s+/)
              this.method = parts[0]
              var url = this.url = parts[1]
              parts = url.split('?')
              this.path = parts[0]
              this.query = parseQuery(parts[1])
            }
          // The body comes after an empty line.
          } else {
            this.body = lines.slice(index + 1).join('\r\n')
            this.next()
          }
        }
      }
    }
  }),

  State: Type.extend(function State () {})
})

var Beams = Cache.extend(function Beams (server) {
  Cache.call(this)
  this.server = server
  this.n = 0
})

Server.Socket = Transfer

exports.serve = function (options) {
  var server = new Server(options)
  return server
}

function parseQuery (query) {
  var data = {}
  if (query) {
    var parts = query.split('&')
    for (var i = 0, l = parts.length; i < l; i++) {
      var pair = parts[i].split('=')
      data[decodeURIComponent(pair[0])] = decodeURIComponent(pair[1])
    }
  }
  return data
}
