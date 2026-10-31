#!/usr/bin/env node
/**
 * 零依赖静态文件服务器，用于本地 demo / 自动化测试靶子。
 * 用法：node demo-app/server.mjs [--port 4173] [--host 127.0.0.1]
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HOST = '127.0.0.1';
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

// 依次尝试 `--name value` 与 `--name=value` 两种写法；没出现则返回 undefined。
function readOption(argv, name) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === `--${name}`) {
      return i + 1 < argv.length ? argv[i + 1] : '';
    }
    if (arg.startsWith(`--${name}=`)) {
      return arg.slice(`--${name}=`.length);
    }
  }
  return undefined;
}

function parsePort(argv) {
  const raw = readOption(argv, 'port');
  if (raw === undefined) {
    return DEFAULT_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`invalid --port value: ${raw}`);
    process.exit(1);
  }
  return port;
}

// 默认只监听回环地址；runner 与浏览器分容器时用 --host 0.0.0.0 放开。
function parseHost(argv) {
  const raw = readOption(argv, 'host');
  if (raw === undefined) {
    return DEFAULT_HOST;
  }
  if (raw === '') {
    console.error('invalid --host value: (empty)');
    process.exit(1);
  }
  return raw;
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
const host = parseHost(process.argv.slice(2));

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
  } catch (error) {
    // 只有「不存在」才是 404；EACCES / ELOOP / ENAMETOOLONG 等属于环境问题，报 500 并留日志。
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      sendText(res, 404, 'Not Found');
      return;
    }
    console.error(`failed to read ${filePath}: ${error && error.message ? error.message : error}`);
    sendText(res, 500, 'Internal Server Error');
  }
});

server.on('error', (error) => {
  console.error(`failed to start server: ${error.message}`);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`listening on http://${host}:${port}`);
});

let shuttingDown = false;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    // server.close() 只停止接受新连接，已建立的 keep-alive 连接会让进程挂着等浏览器超时；
    // 作为被 runner 反复启停的靶子，这里主动断开空闲连接、再兜底断开全部连接和硬退出。
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    server.close(() => process.exit(0));
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
    setTimeout(() => {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
    }, 200).unref();
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
