'use strict'

// Support mocha.
var bench = global.bench || function () {}

var http = require('http')
var lite = require('../lighter-http')
var httpPort = 9881
var litePort = 9882

var liteServer = lite.serve({
  port: litePort,
  handle: function (transfer) {
    transfer.end('Hello World!')
  }
})
var httpServer = http.createServer(function (request, response) {
  response.end('Hello World!')
}).listen(httpPort)

bench('Hello World', function () {
  after(function () {
    liteServer.close()
    httpServer.close()
  })

  it('http', function (done) {
    var url = 'http://127.0.0.1:' + httpPort + '/'
    http.get(url, function (response) {
      response.on('data', function (chunk) {
        done()
      })
    })
  })

  it('lighter-http', function (done) {
    var url = 'http://127.0.0.1:' + litePort + '/'
    http.get(url, function (response) {
      response.on('data', function (chunk) {
        done()
      })
    })
  })
})
