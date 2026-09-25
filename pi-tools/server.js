#!/usr/bin/env node
/**
 * pi-tools - a small file browser + command runner for the Pi itself.
 *
 * Not part of the radar app - this is a separate admin tool, meant to only ever be reached over
 * your own LAN (http://192.168.0.187:6969 or similar), never exposed through the Cloudflare
 * tunnel or the internet. It lets you browse folders under ROOT_DIR, view/edit text files, and
 * run shell commands with a chosen working directory - from your phone or PC's browser instead
 * of opening an SSH session.
 *
 * SECURITY: with no PI_TOOLS_TOKEN set, this has NO authentication at all - anyone who can reach
 * this port can read/write files under ROOT_DIR and run arbitrary commands as whatever user runs
 * this process. That's fine on a home LAN you trust, but:
 *   - Do NOT port-forward this or put it behind the Cloudflare tunnel.
 *   - Set PI_TOOLS_TOKEN to require a shared secret (see below) if anything untrusted (guest
 *     wifi, IoT devices, etc.) shares your network.
 *
 * Run:
 *   node pi-tools/server.js
 *   PORT=6969 ROOT_DIR=/home/radar PI_TOOLS_TOKEN=somesecret node pi-tools/server.js
 *
 * Env vars:
 *   PORT             default 6969
 *   ROOT_DIR         default the home directory of whoever runs this. All file/command access is
 *                    confined under here - paths are resolved and checked to stay inside it.
 *   PI_TOOLS_TOKEN   if set, every /api/* request must send header X-Auth-Token matching it (the
 *                    page will prompt for it once and remember it in localStorage).
 *   CMD_TIMEOUT_MS   default 60000 - a run command is killed if it hasn't finished by then.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { URL } = require('url');

const PORT = process.env.PORT || 6969;
const ROOT_DIR = path.resolve(process.env.ROOT_DIR || os.homedir());
const TOKEN = process.env.PI_TOOLS_TOKEN || '';
const CMD_TIMEOUT_MS = Number(process.env.CMD_TIMEOUT_MS) || 60000;
const MAX_READ_BYTES = 2 * 1024 * 1024; // 2MB - this is a text viewer/editor, not a binary tool
const MAX_CMD_BUFFER = 5 * 1024 * 1024;

// Resolves a path the client sent (relative to ROOT_DIR) and refuses anything that escapes it.
function resolveSafe(rel) {
  const target = path.resolve(ROOT_DIR, '.' + path.sep + (rel || ''));
  if (target !== ROOT_DIR && !target.startsWith(ROOT_DIR + path.sep)) {
    throw new Error('Path escapes ROOT_DIR');
  }
  return target;
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, { 'Content-Type': 'application/json' }, JSON.stringify(obj));
}

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function checkAuth(req) {
  if (!TOKEN) return true;
  return req.headers['x-auth-token'] === TOKEN;
}

async function handleList(req, res, url) {
  try {
    const dir = resolveSafe(url.searchParams.get('path') || '');
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) { sendJson(res, 400, { error: 'Not a directory' }); return; }
    const entries = fs.readdirSync(dir, { withFileTypes: true }).map((d) => {
      let size = 0;
      let mtime = null;
      try {
        const st = fs.statSync(path.join(dir, d.name));
        size = st.size;
        mtime = st.mtime;
      } catch (_) { /* broken symlink etc - still list it */ }
      return { name: d.name, isDir: d.isDirectory(), isSymlink: d.isSymbolicLink(), size, mtime };
    }).sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    sendJson(res, 200, { path: path.relative(ROOT_DIR, dir) || '.', root: ROOT_DIR, entries });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

async function handleRead(req, res, url) {
  try {
    const file = resolveSafe(url.searchParams.get('path') || '');
    const stat = fs.statSync(file);
    if (!stat.isFile()) { sendJson(res, 400, { error: 'Not a file' }); return; }
    if (stat.size > MAX_READ_BYTES) {
      sendJson(res, 413, { error: `File too large to view here (${(stat.size / 1024 / 1024).toFixed(1)} MB, limit 2 MB)` });
      return;
    }
    const content = fs.readFileSync(file, 'utf8');
    sendJson(res, 200, { path: path.relative(ROOT_DIR, file), content, size: stat.size });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

async function handleWrite(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const file = resolveSafe(body.path || '');
    fs.writeFileSync(file, body.content ?? '', 'utf8');
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

async function handleMkdir(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const dir = resolveSafe(body.path || '');
    fs.mkdirSync(dir, { recursive: true });
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

async function handleDelete(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const target = resolveSafe(body.path || '');
    if (target === ROOT_DIR) { sendJson(res, 400, { error: 'Refusing to delete ROOT_DIR itself' }); return; }
    fs.rmSync(target, { recursive: true, force: false });
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

async function handleRun(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const cwd = resolveSafe(body.cwd || '');
    const command = String(body.command || '');
    if (!command.trim()) { sendJson(res, 400, { error: 'No command given' }); return; }
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) { sendJson(res, 400, { error: 'cwd is not a directory' }); return; }

    exec(command, { cwd, shell: '/bin/bash', timeout: CMD_TIMEOUT_MS, maxBuffer: MAX_CMD_BUFFER }, (error, stdout, stderr) => {
      sendJson(res, 200, {
        stdout,
        stderr,
        code: error ? (error.code ?? 1) : 0,
        timedOut: !!(error && error.killed && error.signal === 'SIGTERM'),
        error: error && !error.killed ? null : (error ? 'Command timed out' : null),
      });
    });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

const INDEX_HTML_PATH = path.join(__dirname, 'index.html');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
      send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, html);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (!checkAuth(req)) { sendJson(res, 401, { error: 'Bad or missing token' }); return; }
      if (req.method === 'GET' && url.pathname === '/api/list') { await handleList(req, res, url); return; }
      if (req.method === 'GET' && url.pathname === '/api/read') { await handleRead(req, res, url); return; }
      if (req.method === 'POST' && url.pathname === '/api/write') { await handleWrite(req, res); return; }
      if (req.method === 'POST' && url.pathname === '/api/mkdir') { await handleMkdir(req, res); return; }
      if (req.method === 'POST' && url.pathname === '/api/delete') { await handleDelete(req, res); return; }
      if (req.method === 'POST' && url.pathname === '/api/run') { await handleRun(req, res); return; }
      sendJson(res, 404, { error: 'Unknown API route' });
      return;
    }

    send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`pi-tools listening on 0.0.0.0:${PORT}`);
  console.log(`ROOT_DIR: ${ROOT_DIR}`);
  console.log(TOKEN ? 'Auth: PI_TOOLS_TOKEN is set - requests need X-Auth-Token.' :
    'Auth: NONE. Anyone who can reach this port can read/write files and run commands as this user. Set PI_TOOLS_TOKEN to require a token, and never expose this beyond your LAN.');
});
