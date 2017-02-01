process.isLighterTcpMaster = true
var http = require('http')
var lite = require('lighter-http')
var cluster = require('cluster')
var cpus = 1 // require('os').cpus().length
var content =
  '<html>\n' +
  '<head>\n' +
  '<title>Hello World!</title>\n' +
  '</head>\n' +
  '<h1>HTTP Test</h1>\n' +
  '<p>This page is for latency and throughput testing purposes.</p>\n' +
  '</body>\n' +
  '</html>\n'

if (cluster.isMaster) {
  for (var i = 0; i < cpus; i++) {
    cluster.fork()
  }
} else {
  http.createServer(function (request, response) {
    response.setHeader('Content-Type', 'text/html')
    response.end(content)
  }).listen(8124)

  lite.serve({
    port: 8125,
    isWorker: true,
    handle: function (transfer) {
      transfer.response['Content-Type'] = 'text/html'
      transfer.end(content)
    }
  })
}
