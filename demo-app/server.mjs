#!/usr/bin/env node
/**
 * 零依赖静态文件服务器，用于本地 demo / 自动化测试靶子。
 * 用法：node demo-app/server.mjs [--port 4173]
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const DEFAULT_PORT = 4173;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function parsePort(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let raw = null;
    if (arg === '--port') {
      raw = argv[i + 1];
    } else if (arg.startsWith('--port=')) {
      raw = arg.slice('--port='.length);
    }
    if (raw === null) {
      continue;
    }
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`invalid --port value: ${raw}`);
      process.exit(1);
    }
    return port;
  }
  return DEFAULT_PORT;
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(text);
}

function resolvePathname(requestUrl) {
  const pathname = decodeURIComponent((requestUrl || '/').split('?')[0]);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(ROOT, relative);
  const rootWithSep = ROOT + path.sep;
  if (filePath !== ROOT && !filePath.startsWith(rootWithSep)) {
    return null;
  }
  return filePath;
}

const port = parsePort(process.argv.slice(2));

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    sendText(res, 405, 'Method Not Allowed');
    return;
  }

  let filePath;
  try {
    filePath = resolvePathname(req.url);
  } catch {
    sendText(res, 400, 'Bad Request');
    return;
  }
  if (filePath === null) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    const target = info.isDirectory() ? path.join(filePath, 'index.html') : filePath;
    const targetInfo = info.isDirectory() ? await stat(target) : info;
    if (!targetInfo.isFile()) {
      sendText(res, 404, 'Not Found');
      return;
    }

    const contentType =
      MIME_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': targetInfo.size,
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(target);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch {
    sendText(res, 404, 'Not Found');
  }
});

server.on('error', (error) => {
  console.error(`failed to start server: ${error.message}`);
  process.exit(1);
});

server.listen(port, HOST, () => {
  console.log(`listening on http://${HOST}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
