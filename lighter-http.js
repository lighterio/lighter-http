'use strict'

var http = require('http')
var mime = require('lighter-mime')
var tcp = require('lighter-tcp')
var Flagger = require('lighter-flagger')
var Cache = require('lighter-lru-cache')
var Type = require('lighter-type')
// var multipart = require('./multipart')
var doNothing = function () {}
var BEAM = 'BEAM:'
var beamTimeout = 3e4

// Maximum number of bytes we can receive (to avoid storage attacks).
// var MAX_BYTES = 1e8 // ~100MB.

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

var codes = http.STATUS_CODES
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
  tcp.Server.call(this, options)
  this.routes = {
    GET: {'/BEAM': beamDown},
    POST: {'/BEAM': beamUp}
  }
  this.steps = []
  this.views = {}
  this.beams = new this.Beams(this)
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
    this.on(BEAM + name, fn)
  },

  Beams: Cache.extend(function Beams (server) {
    Cache.call(this)
    this.server = server
    this.seed = 0
  }, {
    on: function (type, fn) {
      this.server.on(BEAM + type, fn)
    }
  }),

  Events: tcp.Server.prototype.Events.extend(function Events () {}, {
    connection: function (socket) {
      // Ignore hangups.
      socket.on('error', doNothing)
    }
  })
})

Server.prototype.Socket = exports.Socket = tcp.Socket.extend({
  Events: tcp.Server.prototype.Events.extend(function Events () {}, {
    data: function data (chunk) {
      // Continue or start a transfer.
      var transfer = this.transfer
      if (!transfer) {
        transfer = this.transfer = new this.server.Transfer(this)
        this.server.concurrent++
      }

      var lines = chunk.toString().split('\r\n')
      for (var i = 0, l = lines.length; i < l; i++) {
        var line = lines[i]
        // Continue until there's an empty line.
        if (line) {
          // Treat each line after the 1st as a header.
          if (i) {
            var colon = line.indexOf(':')
            var name = line.substr(0, colon).toLowerCase()
            var value = line.substr(colon + 1).trim()
            transfer.request[name] = value
          } else {
            var parts = line.split(/\s+/)
            transfer.method = parts[0]
            var url = transfer.url = parts[1]
            if (url) {
              parts = url.split('?')
              transfer.path = parts[0]
              transfer.query = parseQuery(parts[1])
            } else {
              var error = new Error('HTTP Parse Error: ' + chunk.toString())
              this.emit('error', error)
            }
          }
        // The body comes after an empty line.
        } else {
          this.transfer = undefined
          transfer.body = lines.slice(i + 1).join('\r\n')
          return transfer.next()
        }
      }
    }
  })
})

Server.prototype.Transfer = exports.Transfer = Flagger.extend(function Transfer (socket) {
  this.socket = socket
  this.request = {}
  this.response = {}
  this.state = new this.State()
  this.status = 200
  this.body = ''
  this._start = Date.now()
  this._headerSent = false
  this._step = 0
  this._events = new this.Events()
  this._steps = socket.server.steps
  this._routes = socket.server.routes
}, {

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
      var fn = this._steps[this._step++]
      if (!fn) {
        return this._finish()
      }
      ok = fn.call(this)
    } while (ok === true)
  },

  _finish: function _finish () {
    var method = this.method
    var path = this.path
    var routes = this._routes

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
    var socket = this.socket
    var server = socket.server
    text = text || ''

    // Write headers first if necessary.
    if (this._headerSent === false) {
      this.response['Content-Length'] = text.length
      text = this._getHeader() + text
      this._headerSent = true
    }

    socket.write(text)
    if (!--server.concurrent) {
      server.emit('idle')
    }
  },

  /**
   * Render a view with a given name and optional data.
   *
   * @param  {String} name  The name of the view to render.
   * @param  {Object} data  Data to pass to the view function.
   */
  view: function (name, data) {
    var views = this.socket.server.views
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
    var number = this._number = (this._number || 0) + 1
    this._queue.push([name, data, number])
    if (!this._headerSent) {
      this.response['Access-Control-Allow-Origin'] = '*'
      this.response['Content-Type'] = 'text/json'
      this.end(JSON.stringify(this._queue))
      this._queue = []
    }
  },

  _beamTimeout: 3e4,

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
  },

  Events: Type.extend(function Events () {}),
  State: Type.extend(function State () {})
})

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

function resetBeam (beam) {
  clearTimeout(beam.timer)
  beam.timer = setTimeout(function () {
    beam.emit(BEAM + 'timeout')
    beam.socket.server.emit(BEAM + 'timeout')
  }, beamTimeout)
}

function beamDown () {
  var id = this.query.id
  var beams = this.socket.server.beams
  var beam = beams.get(id)
  if (!beam || (id !== beam._id)) {
    beams.seed = beams.seed % 1e18 + Math.floor(Math.random() * 1e12)
    id = this._id = 'B' + beams.seed.toString(36)
    beams.set(id, this)
    this._queue = []
    resetBeam(this)
    this.beam('connect', {id: id})
  }
}

function beamUp () {
  var body = this.body
  try {
    var list = JSON.parse(body)
    for (var i = 0, l = list.length; i < l; i++) {
      var data = list[i]
      var e = BEAM + data[0]
      var n = data[1]
      var d = data[2]
      this.emit(e, d, this, n)
      this.socket.server.emit(e, d, this, n)
      this.end('OK')
    }
  } catch (e) {
    this.emit('error', e)
  }
}
