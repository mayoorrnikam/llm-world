#!/usr/bin/env node
/** Minimal static server for local preview — no dependencies. */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const PORT = Number(process.env.PORT) || 8777;
const ROOT = process.cwd();
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

createServer(async (req, res) => {
  try {
    // Strip the query/hash, then block traversal above the project root.
    const rel = normalize(decodeURIComponent(req.url.split(/[?#]/)[0]));
    if (rel.includes('..')) { res.writeHead(403).end('Forbidden'); return; }

    let file = join(ROOT, rel);
    if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');

    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    }).end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, () => console.log(`preview → http://localhost:${PORT}`));
