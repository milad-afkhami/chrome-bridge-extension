#!/usr/bin/env node
// Chrome Bridge — MCP stdio server + browser WebSocket bridge.
//
// Multiple server instances COOPERATE instead of fighting over the port:
//   - the first instance to bind PORT becomes the HUB (owns the extension link);
//   - any later instance becomes a CONTROLLER that forwards its tool calls to the
//     hub over the same port.
// If the hub dies, a controller promotes itself. This permanently avoids the
// "two servers, extension talks to the wrong one" split-brain — no manual cleanup.
// Servers also exit when their parent (Claude Code) goes away.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.BRIDGE_PORT || 9223);

// A bug in one tool must never crash the bridge.
process.on('uncaughtException', (e) => console.error('[chrome-bridge] uncaught:', (e && e.stack) || e));
process.on('unhandledRejection', (e) => console.error('[chrome-bridge] unhandledRejection:', e));

let role = 'starting'; // 'starting' | 'hub' | 'controller'
let extSock = null; // hub: the extension WebSocket
let hubSock = null; // controller: our WebSocket to the hub
const localPending = new Map(); // our own tool calls: id -> {resolve, reject}
const ctlPending = new Map(); // controller: cid -> {resolve, reject}
const routes = new Map(); // hub: extReplyId -> {ctl, cid} for proxied controller calls

function safeSend(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }

// ---------------- HUB ----------------
function startHub() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });
  wss.on('listening', () => { role = 'hub'; console.error(`[chrome-bridge] HUB on ws://127.0.0.1:${PORT}`); });
  wss.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') { try { wss.close(); } catch {} becomeController(); }
    else console.error('[chrome-bridge] hub error:', e && e.message);
  });
  wss.on('connection', (ws) => {
    ws.once('message', (first) => {
      let m; try { m = JSON.parse(first.toString()); } catch { ws.close(); return; }
      if (m.hello === 'ext') attachExtension(ws);
      else if (m.hello === 'ctl') attachController(ws);
      else ws.close();
    });
  });
}

function attachExtension(ws) {
  extSock = ws;
  console.error('[chrome-bridge] extension connected');
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    const local = localPending.get(m.id);
    if (local) { localPending.delete(m.id); m.error ? local.reject(new Error(m.error)) : local.resolve(m.result); return; }
    const r = routes.get(m.id);
    if (r) { routes.delete(m.id); safeSend(r.ctl, { t: 'reply', cid: r.cid, result: m.result, error: m.error }); }
  });
  ws.on('close', () => { if (extSock === ws) extSock = null; });
  ws.on('error', () => { if (extSock === ws) extSock = null; });
}

function attachController(ws) {
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    if (m.t !== 'cmd') return;
    if (!extSock || extSock.readyState !== WebSocket.OPEN) { safeSend(ws, { t: 'reply', cid: m.cid, error: 'extension not connected' }); return; }
    const id = randomUUID();
    routes.set(id, { ctl: ws, cid: m.cid });
    safeSend(extSock, { id, action: m.action, params: m.params });
    setTimeout(() => { if (routes.has(id)) { routes.delete(id); safeSend(ws, { t: 'reply', cid: m.cid, error: 'timeout' }); } }, 35000);
  });
  ws.on('close', () => { for (const [id, r] of routes) if (r.ctl === ws) routes.delete(id); });
}

// ---------------- CONTROLLER ----------------
function becomeController() { role = 'controller'; connectToHub(); }

function connectToHub() {
  let ws;
  try { ws = new WebSocket(`ws://127.0.0.1:${PORT}`); } catch { return retryBridge(); }
  ws.on('open', () => { hubSock = ws; safeSend(ws, { hello: 'ctl' }); console.error('[chrome-bridge] CONTROLLER connected to hub'); });
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    if (m.t === 'reply') { const p = ctlPending.get(m.cid); if (p) { ctlPending.delete(m.cid); m.error ? p.reject(new Error(m.error)) : p.resolve(m.result); } }
  });
  ws.on('close', () => { if (hubSock === ws) hubSock = null; retryBridge(); });
  ws.on('error', () => { try { ws.close(); } catch {} });
}

let retrying = false;
function retryBridge() {
  if (retrying || role === 'hub') return;
  retrying = true;
  setTimeout(() => { retrying = false; role = 'starting'; startHub(); }, 800);
}

// ---------------- unified call for tool handlers ----------------
function call(action, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (role === 'hub') {
      if (!extSock || extSock.readyState !== WebSocket.OPEN)
        return reject(new Error(`Chrome Bridge extension not connected (it auto-connects to ws://127.0.0.1:${PORT}).`));
      const id = randomUUID();
      localPending.set(id, { resolve, reject });
      safeSend(extSock, { id, action, params });
      setTimeout(() => { if (localPending.has(id)) { localPending.delete(id); reject(new Error(`Timed out after ${timeoutMs}ms`)); } }, timeoutMs);
    } else if (role === 'controller') {
      if (!hubSock || hubSock.readyState !== WebSocket.OPEN)
        return reject(new Error('Chrome Bridge hub not reachable yet; retry in a moment.'));
      const cid = randomUUID();
      ctlPending.set(cid, { resolve, reject });
      safeSend(hubSock, { t: 'cmd', cid, action, params });
      setTimeout(() => { if (ctlPending.has(cid)) { ctlPending.delete(cid); reject(new Error(`Timed out after ${timeoutMs}ms`)); } }, timeoutMs);
    } else {
      reject(new Error('Chrome Bridge starting up; retry in a moment.'));
    }
  });
}

const out = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });

// ---------------- MCP server + tools ----------------
const server = new McpServer({ name: 'chrome-bridge', version: '0.2.0' });

server.registerTool('list_tabs',
  { description: 'List open browser tabs as [{tabId, url, title, active}]. Read-only; never changes focus.', inputSchema: {} },
  async () => out(await call('list_tabs')));

server.registerTool('exec',
  {
    description:
      'Run JavaScript in a tab and return its value (must be JSON-serializable). Runs in the page ' +
      'MAIN world via chrome.scripting — no debugger banner, and does NOT focus or raise the tab. ' +
      'The code is an async function body: use `return ...` and top-level `await`. ' +
      'Note: pages with a strict Content-Security-Policy can block eval-based exec (rare).',
    inputSchema: {
      code: z.string().describe('JavaScript to run, e.g. "return document.title" or "document.querySelector(\'#x\').click()"'),
      tabId: z.number().optional().describe('Target tab id from list_tabs. Omit to use the active tab.'),
    },
  },
  async ({ code, tabId }) => out(await call('exec', { code, tabId })));

server.registerTool('read',
  {
    description:
      'Read a tab\'s content without focusing it. Returns visible text by default, or outerHTML when ' +
      'html=true. Optional CSS selector to read a single element instead of the whole document.',
    inputSchema: {
      tabId: z.number().optional().describe('Target tab id. Omit to use the active tab.'),
      selector: z.string().optional().describe('CSS selector; omit for the whole document.'),
      html: z.boolean().optional().describe('true = outerHTML, false/omit = innerText.'),
    },
  },
  async ({ tabId, selector, html }) => out(await call('read', { tabId, selector, html })));

server.registerTool('navigate',
  {
    description: 'Navigate a tab to a URL in the background (does not focus/raise it). Omit tabId to use the active tab.',
    inputSchema: { url: z.string(), tabId: z.number().optional() },
  },
  async ({ url, tabId }) => out(await call('navigate', { url, tabId })));

server.registerTool('open_tab',
  {
    description:
      'Open a new tab, in the BACKGROUND by default (does not focus it). active:true focuses it; ' +
      'newWindow:true opens a new window; incognito:true opens an isolated window with its own ' +
      'cookie jar (NOT logged in). Returns {tabId, windowId}. Combine with per-tabId exec/read to ' +
      'drive several tabs in parallel.',
    inputSchema: {
      url: z.string().optional().describe('URL to open; omit for about:blank.'),
      active: z.boolean().optional().describe('Focus the new tab (default false).'),
      newWindow: z.boolean().optional(),
      incognito: z.boolean().optional().describe('Isolated incognito window (separate cookies; logged out).'),
    },
  },
  async (a) => out(await call('open_tab', a)));

server.registerTool('close_tab',
  { description: 'Close a tab by id.', inputSchema: { tabId: z.number() } },
  async ({ tabId }) => out(await call('close_tab', { tabId })));

server.registerTool('screenshot',
  {
    description:
      'Capture a PNG of a tab and return it as an image. No tabId → captures the currently visible ' +
      'tab (zero disturbance). With a tabId that is not frontmost, the tab is briefly flashed to the ' +
      'front to render, then the previous tab is restored (a short flicker — the only tool that ' +
      'touches focus, and only for a moment).',
    inputSchema: { tabId: z.number().optional() },
  },
  async ({ tabId }) => {
    const r = await call('screenshot', { tabId });
    const b64 = String((r && r.dataUrl) || '').replace(/^data:image\/png;base64,/, '');
    if (!b64) return out(r);
    return { content: [{ type: 'image', data: b64, mimeType: 'image/png' }] };
  });

server.registerTool('upload_file',
  {
    description:
      'Set the file(s) on a file <input> so a form can upload them. This is the ONE operation the ' +
      'browser only permits via the debugger, so it briefly shows the "debugging this browser" ' +
      'banner (detaches immediately after). Provide a CSS selector for the input and ABSOLUTE file ' +
      'paths on this machine.',
    inputSchema: {
      selector: z.string().describe('CSS selector of the <input type="file">.'),
      filePaths: z.array(z.string()).describe('Absolute paths, e.g. ["/home/milad/x.pdf"].'),
      tabId: z.number().optional(),
    },
  },
  async ({ selector, filePaths, tabId }) => out(await call('upload_file', { selector, filePaths, tabId }, 60000)));

server.registerTool('network_capture',
  {
    description:
      'Record network requests (URL, method, resource type, status, timing) via the webRequest API ' +
      '— no banner. action:"start" begins buffering (optionally filtered to one tabId); ' +
      'action:"stop" returns the buffered requests and clears the buffer. Response BODIES are not ' +
      'captured (that needs the debugger) — use exec+fetch if you need a body.',
    inputSchema: {
      action: z.enum(['start', 'stop']),
      tabId: z.number().optional().describe('On start: capture only this tab. Omit for all tabs.'),
    },
  },
  async ({ action, tabId }) => out(await call('network_capture', { action, tabId })));

// Start the bridge, then connect MCP.
startHub();

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[chrome-bridge] MCP up');

// Exit when the parent (Claude Code) goes away — reliably. stdin EOF and signals
// cover the normal cases; the ppid watch catches the rest (reparent to init).
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
const ppidWatch = setInterval(() => { if (process.ppid === 1) process.exit(0); }, 3000);
if (ppidWatch.unref) ppidWatch.unref();
