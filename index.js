var http = require('http')
var lighterHttp = require('lighter-http')

var server = new lighterHttp.Server({
  port: 8124,
  handle: function (transfer) {
    transfer.response['Content-Type'] = 'text/html'
    transfer.send('Hello World!')
  }
})
server.ok = true

// Create an HTTP server.
var simple = http.createServer(function (request, response) {
  response.writeHead(200, {'content-type': 'text/html'})
  response.end('Hello World!')
})
simple.listen(8125)
