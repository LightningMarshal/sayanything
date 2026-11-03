'use strict';

/*
 * Stand-in for whisper.cpp v1.9.1 `whisper-server`, used by
 * test/whisper-server-test.js. Accepts the same flags the app passes
 * (-m, --host, --port, -t, --request-path) and mimics the upstream routing:
 * every route is registered under --request-path (GET /, GET /health,
 * POST /inference, POST /load) and anything else is 404. Sends the same
 * permissive CORS header upstream does. Prints "PATH <path>" per request so the
 * test can see which URLs the app used.
 */

const http = require('http');

const argv = process.argv.slice(2);
function arg(flag, dflt) {
  const i = argv.indexOf(flag);
  return i === -1 ? dflt : argv[i + 1];
}
const host = arg('--host', '127.0.0.1');
const port = Number(arg('--port', '8080'));
const rp = arg('--request-path', '');

const srv = http.createServer(function (req, res) {
  const url = (req.url || '/').split('?')[0];
  process.stdout.write('PATH ' + url + '\n');
  req.on('data', function () {});
  req.on('end', function () {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'GET' && url === rp + '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end('{"status":"ok"}');
    } else if (req.method === 'POST' && url === rp + '/inference') {
      res.setHeader('Content-Type', 'application/json');
      res.end('{"text":"fake transcript"}');
    } else if (req.method === 'POST' && url === rp + '/load') {
      res.end('Load was successful!');
    } else if (req.method === 'GET' && url === rp + '/') {
      res.end('<html></html>');
    } else {
      res.statusCode = 404;
      res.end('File Not Found (' + url + ')');
    }
  });
});
srv.listen(port, host);
process.on('SIGTERM', function () { srv.close(); process.exit(0); });
