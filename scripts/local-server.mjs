#!/usr/bin/env node
/** Loopback-only static server and tightly scoped Ollama controller. */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const PORT = Math.min(65535, Math.max(1024, Number(process.env.ANZEIGENPIRATEN_PORT) || 4173));
const OLLAMA = 'http://127.0.0.1:11434';
const OLLAMA_EXECUTABLE = process.env.OLLAMA_EXECUTABLE || 'ollama';
let managedProcess = null;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
};

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

function localHostHeader(value) {
  const host = String(value || '').toLowerCase();
  return host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}` || host === `127.0.0.1` || host === `localhost`;
}

function localOrigin(value) {
  try {
    const origin = new URL(value);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
      && (!origin.port || Number(origin.port) === PORT);
  } catch { return false; }
}

async function ollamaJson(route, timeoutMs = 1800) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${OLLAMA}${route}`, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`Ollama antwortet mit HTTP ${response.status}.`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

async function status() {
  try {
    const [tags, ps] = await Promise.all([ollamaJson('/api/tags'), ollamaJson('/api/ps')]);
    return {
      online: true,
      managed: Boolean(managedProcess && managedProcess.exitCode === null),
      models: (tags.models ?? []).map(({ name, size, modified_at }) => ({ name, size, modifiedAt: modified_at })),
      loadedModels: (ps.models ?? []).map(({ name, size, size_vram }) => ({ name, size, sizeVram: size_vram })),
    };
  } catch (error) {
    return { online: false, managed: false, models: [], loadedModels: [], error: error.name === 'AbortError' ? 'Zeitüberschreitung bei Ollama.' : error.message };
  }
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

async function stopManaged() {
  if (!managedProcess || managedProcess.exitCode !== null) {
    managedProcess = null;
    throw new Error('Ollama wurde nicht von diesem AnzeigenPiraten-Server gestartet und wird daher nicht beendet.');
  }
  const child = managedProcess;
  child.kill();
  if (!await waitForExit(child, 5000)) {
    child.kill('SIGKILL');
    await waitForExit(child, 1000);
  }
  managedProcess = null;
  // Give the local API a moment to release its port.
  await new Promise((resolve) => setTimeout(resolve, 350));
}

async function startManaged() {
  const current = await status();
  if (current.online) throw new Error('Ollama läuft bereits.');
  const child = spawn(OLLAMA_EXECUTABLE, ['serve'], { windowsHide: true, stdio: 'ignore', shell: false });
  managedProcess = child;
  let startupError = null;
  child.once('error', (error) => {
    startupError = error;
    if (managedProcess === child) managedProcess = null;
  });
  child.once('exit', () => { if (managedProcess === child) managedProcess = null; });
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (startupError) throw new Error(`Ollama konnte nicht gestartet werden: ${startupError.message}`);
    if (child.exitCode !== null) throw new Error(`Ollama konnte nicht gestartet werden (Exit-Code ${child.exitCode}).`);
    if ((await status()).online) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  try { await stopManaged(); } catch { /* retain the useful startup timeout below */ }
  throw new Error('Ollama hat innerhalb von 12 Sekunden nicht geantwortet. Prüfe die Ollama-Installation.');
}

async function control(action) {
  const current = await status();
  if (action === 'start') {
    await startManaged();
    return { message: 'Ollama wurde gestartet.', ...(await status()) };
  }
  if (action === 'stop') {
    if (!current.online) throw new Error('Ollama läuft bereits nicht.');
    await stopManaged();
    return { message: 'Ollama wurde beendet.', ...(await status()) };
  }
  if (action === 'restart') {
    if (current.online && !current.managed) throw new Error('Ollama läuft extern. Aus Sicherheitsgründen kann nur ein von AnzeigenPiraten gestarteter Prozess neu gestartet werden.');
    if (current.online) await stopManaged();
    await startManaged();
    return { message: 'Ollama wurde neu gestartet.', ...(await status()) };
  }
  throw new Error('Unbekannte Aktion.');
}

const server = http.createServer(async (req, res) => {
  if (!localHostHeader(req.headers.host)) return json(res, 403, { error: 'Nur lokale Zugriffe sind erlaubt.' });
  const pathname = new URL(req.url, `http://${HOST}:${PORT}`).pathname;

  if (pathname.startsWith('/api/ollama')) {
    if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { error: 'Methode nicht erlaubt.' });
    if (req.method === 'POST' && !localOrigin(req.headers.origin)) return json(res, 403, { error: 'Ungültiger Herkunftsserver.' });
    if (pathname === '/api/ollama/status' && req.method === 'GET') return json(res, 200, await status());
    const match = pathname.match(/^\/api\/ollama\/(start|stop|restart)$/);
    if (req.method === 'POST' && match) {
      try { return json(res, 200, await control(match[1])); }
      catch (error) { return json(res, 409, { error: error.message }); }
    }
    return json(res, 404, { error: 'Endpunkt nicht gefunden.' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Methode nicht erlaubt.' });
  let pathnameDecoded;
  try { pathnameDecoded = decodeURIComponent(pathname); } catch { return json(res, 400, { error: 'Ungültiger Pfad.' }); }
  const relative = pathnameDecoded === '/' ? 'index.html' : pathnameDecoded.replace(/^\/+/, '');
  if (relative !== 'index.html' && !relative.startsWith('assets/') && !relative.startsWith('data/')) {
    return json(res, 404, { error: 'Datei nicht gefunden.' });
  }
  const file = path.resolve(ROOT, relative);
  if (!file.startsWith(`${ROOT}${path.sep}`)) return json(res, 403, { error: 'Zugriff verweigert.' });
  try {
    if (!(await stat(file)).isFile()) throw new Error('Not a file');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { json(res, 404, { error: 'Datei nicht gefunden.' }); }
});

server.listen(PORT, HOST, () => console.log(`AnzeigenPiraten lokal: http://${HOST}:${PORT}`));
server.on('error', (error) => { console.error(`Lokaler Server konnte nicht starten: ${error.message}`); process.exitCode = 1; });
process.on('SIGINT', () => { if (managedProcess?.exitCode === null) managedProcess.kill(); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { if (managedProcess?.exitCode === null) managedProcess.kill(); server.close(() => process.exit(0)); });
