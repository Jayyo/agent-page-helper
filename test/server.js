'use strict';
// Minimal static server for the fixture pages. React's UMD builds are served
// from node_modules so the fixtures work offline.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURES = path.join(__dirname, 'fixtures');
const VENDOR = {
  '/vendor/react.production.min.js': ['react', 'umd/react.production.min.js'],
  '/vendor/react-dom.production.min.js': ['react-dom', 'umd/react-dom.production.min.js'],
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.txt': 'text/plain' };

function resolveVendor(urlPath) {
  const entry = VENDOR[urlPath];
  if (!entry) return null;
  const pkgDir = path.dirname(require.resolve(entry[0] + '/package.json'));
  return path.join(pkgDir, entry[1]);
}

function startServer(port = 0) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = resolveVendor(urlPath);
    if (!file) {
      file = path.normalize(path.join(FIXTURES, urlPath === '/' ? 'index.html' : urlPath));
      if (!file.startsWith(FIXTURES + path.sep)) { res.writeHead(403).end(); return; }
    }
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${actual}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

module.exports = { startServer };

if (require.main === module) {
  startServer(Number(process.env.PORT) || 8787).then(({ origin }) => console.log(`fixtures at ${origin}/`));
}
