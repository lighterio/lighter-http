'use strict'

var tcp = require('lighter-tcp')

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
  tcp.Server.call(this, options)
  this.concurrent = 0
  if (options.handle) {
    this.handle = options.handle
  }
}, {
  handle: function (transfer) {
    transfer.response['Content-Type'] = 'text/html'
    transfer.send('ERROR: No transfer handler set.')
  }
}, {
  Events: tcp.Server.Events.extend(function () {}, {
    connection: function (transfer) {

      // Ignore hangups.
      transfer.on('error', function () {})
    }
  })
})

var Request = exports.Request = tcp.Socket.extend(function () {

}, {

})

var Transfer = exports.Transfer = tcp.Socket.extend({

  end: function end (text) {
    var request = this.request
    var response = this.response
    var head = heads[this.status]
    head += '\r\nDate: ' + (new Date()).toUTCString()
    if (request.connection === 'keep-alive') {
      head += '\r\nConnection: keep-alive'
    }
    for (var key in response) {
      head += '\r\n' + key + ': ' + response[key]
    }
    this.write(head + '\r\nContent-Length: ' + text.length + '\r\n\r\n' + text)
    this._transferring = false
    this.server.concurrent--
  }

}, {

  Events: tcp.Server.Events.extend(function () {}, {
    data: function (chunk) {
      var self = this
      var server = this.server
      // Open a new transfer if it's not open.
      if (!self._transferring) {
        server.concurrent++
        self._transferring = true
        self.request = {}
        self.body = ''
        self.response = {}
        self._events = new this.constructor.Events()
      }
      if (self.body) {
        self.body += chunk
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
              self.request[name] = value
            } else {
              var parts = line.split(/\s+/)
              self.method = parts[0]
              self.url = parts[1]
            }
          } else {
            break
          }
        }
        // If we've broken on an empty line, the data comes next.
        if (index < count) {
          self.body = lines.slice(index).join('\r\n')
          self.status = 200
          server.handle(self)
        }
      }
    }
  })

})

Server.Socket = Transfer

exports.serve = function (options) {
  return new Server(options)
}
