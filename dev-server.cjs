'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const api = require('./api/list.js');
const root = __dirname;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const assets = new Set(['index.html', 'app.js', 'catalog.js', 'style.css', 'manifest.webmanifest', 'sw.js']);
http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/api/list') {
    res.status = status => { res.statusCode = status; return res; };
    res.json = value => { res.end(JSON.stringify(value)); return res; };
    return api(req, res);
  }
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['GET', 'HEAD'].includes(req.method) || (!assets.has(file) && !/^icons\/[\w.-]+\.(png|svg)$/.test(file))) { res.writeHead(404); return res.end(); }
  try {
    const body = await fs.readFile(path.join(root, file));
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404); res.end(); }
}).listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Shopping-list development server started.'));
