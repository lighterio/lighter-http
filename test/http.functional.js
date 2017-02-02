var http = require('http')
var is = global.is || require('exam/lib/is')
var port = 31267
var url = 'http://127.0.0.1:' + port + '/'
var lite = require('../lighter-http')

var content = 'Hello World!'

// http.createServer(function (request, response) {
//   response.end(content)
// }).listen(port)

lite.serve({port: port})
  .get('/', function () {
    this.end(content)
  })

describe('Lighter HTTP', function () {
  it('responds', function (done) {
    http.get(url, function (response, data) {
      http.get(url, function (response, data) {
        response.on('data', function (chunk) {
          is(chunk.toString(), content)
          done()
        })
      })
    })
  })
})
