var http = require('http')
var lighterHttp = require('lighter-http')
var cluster = require('cluster')
var cpus = require('os').cpus().length
var content =
  '<html>\n' +
  '<head>\n' +
  '<title>Lighter HTTP Hello World!</title>\n' +
  '</head>\n' +
  '<body bgcolor=white>\n' +
  '<table border="0">\n' +
  '<tr>\n' +
  '<td>\n' +
  '<img src="http://lighter.io/lighter.svg">\n' +
  '</td>\n' +
  '<td>\n' +
  '<h1>Sample Application Server</h1>\n' +
  'This is the output of a server that is part of\n' +
  'the Hello, World application.\n' +
  '</td>\n' +
  '</tr>\n' +
  '</table>\n' +
  '</body>\n' +
  '</html>\n'

if (cluster.isMaster) {
  for (var i = 0; i < cpus; i++) {
    cluster.fork()
  }
} else {
  lighterHttp.serve({
    port: 8124,
    handle: function (transfer) {
      transfer.response['Content-Type'] = 'text/html'
      transfer.send(content)
    }
  })

  http
    .createServer(function (request, response) {
      response.writeHead(200, {'content-type': 'text/html'})
      response.end(content)
    })
    .listen(8125)
}
