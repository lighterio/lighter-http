var http = require('http')
var is = global.is || require('exam/lib/is')
var port = 31267
var url = 'http://127.0.0.1:' + port + '/'
var lighterHttp = require('../lighter-http')

var server = new lighterHttp.Server({port: port})

describe('Lighter HTTP', function () {
  it('responds', function (done) {
    is.object(server)
    http.get(url, function (response, data) {
      http.get(url, function (response, data) {
        response.on('data', function (chunk) {
          is(chunk.toString(), 'Hello World!')
          done()
        })
      })
    })
  })
})
