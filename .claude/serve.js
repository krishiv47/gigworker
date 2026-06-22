// Minimal static file server for the GigGuard preview.
// Hardcoded root so it never calls process.cwd() (blocked in the preview sandbox).
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = '/Users/krishivchawla/Desktop/gigworker';
const PORT = 8765;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',  // always serve fresh during dev
    });
    res.end(buf);
  });
}).listen(PORT, () => console.log('GigGuard serving ' + ROOT + ' on http://localhost:' + PORT));
