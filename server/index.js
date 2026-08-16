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
const server = new McpServer({ name: 'chrome-bridge', version: '0.3.0' });

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
      'Read a tab\'s content without focusing it. format:"text" (default) = visible innerText; ' +
      '"html" = outerHTML; "markdown" = the main/article content as clean Markdown (headings, links, ' +
      'lists, code) — great for reading an article without HTML bloat. Optional CSS selector to read a ' +
      'single element instead of the whole document. Works everywhere incl. strict-CSP sites (no eval).',
    inputSchema: {
      tabId: z.number().optional().describe('Target tab id. Omit to use the active tab.'),
      selector: z.string().optional().describe('CSS selector; omit for the whole document.'),
      format: z.enum(['text', 'html', 'markdown']).optional().describe('text (default) | html | markdown.'),
      html: z.boolean().optional().describe('Deprecated alias for format:"html".'),
    },
  },
  async ({ tabId, selector, format, html }) => out(await call('read', { tabId, selector, format, html })));

server.registerTool('snapshot',
  {
    description:
      'Structured accessibility outline of a tab — the fast way to understand a page and act on it ' +
      'WITHOUT dumping raw HTML. Returns an indented YAML-ish tree of interactive/landmark elements ' +
      'with roles, accessible names, and a stable ref, e.g. `- button "Sign in" [ref=e7]`. Pass those ' +
      'refs to click/fill/hover to act without guessing CSS selectors. Built via a static function ' +
      '(no eval) so it works even on strict-CSP sites where exec is blocked. interactiveOnly:false also ' +
      'includes headings/landmarks for reading structure.',
    inputSchema: {
      tabId: z.number().optional().describe('Target tab id. Omit to use the active tab.'),
      selector: z.string().optional().describe('Limit the snapshot to this container (CSS selector).'),
      interactiveOnly: z.boolean().optional().describe('Default true. false = also list headings/landmarks.'),
    },
  },
  async ({ tabId, selector, interactiveOnly }) => out(await call('snapshot', { tabId, selector, interactiveOnly })));

server.registerTool('click',
  {
    description:
      'Click an element by its snapshot ref (preferred) or a CSS selector. Scrolls it into view first. ' +
      'Runs in the page in the background — no focus change, no banner, works on strict-CSP sites.',
    inputSchema: {
      ref: z.string().optional().describe('A ref from snapshot, e.g. "e7".'),
      selector: z.string().optional().describe('CSS selector (use if you have no ref).'),
      tabId: z.number().optional(),
    },
  },
  async ({ ref, selector, tabId }) => out(await call('click', { ref, selector, tabId })));

server.registerTool('fill',
  {
    description:
      'Type a value into an input/textarea/contenteditable by snapshot ref or CSS selector. Uses the ' +
      'native value setter and fires input+change events so React/Vue notice. submit:true also presses ' +
      'Enter and submits the enclosing form. No focus change, no banner.',
    inputSchema: {
      value: z.string().describe('Text to set.'),
      ref: z.string().optional().describe('A ref from snapshot, e.g. "e12".'),
      selector: z.string().optional().describe('CSS selector (use if you have no ref).'),
      submit: z.boolean().optional().describe('Press Enter / submit the form after filling.'),
      tabId: z.number().optional(),
    },
  },
  async ({ value, ref, selector, submit, tabId }) => out(await call('fill', { value, ref, selector, submit, tabId })));

server.registerTool('hover',
  {
    description:
      'Hover an element by snapshot ref or CSS selector — dispatches real pointer/mouse-over events to ' +
      'trigger hover menus and tooltips that a plain click can\'t. No focus change, no banner.',
    inputSchema: {
      ref: z.string().optional().describe('A ref from snapshot.'),
      selector: z.string().optional().describe('CSS selector.'),
      tabId: z.number().optional(),
    },
  },
  async ({ ref, selector, tabId }) => out(await call('hover', { ref, selector, tabId })));

server.registerTool('wait_for',
  {
    description:
      'Wait until a condition holds in a tab, polling in-page every 250ms (no banner). Provide ONE of: ' +
      'selector (wait until it appears, or disappears if gone:true), or text (wait until the page ' +
      'contains it). With neither, waits for document.readyState === "complete". Returns {ok, waitedMs} ' +
      'or errors on timeout. Use after navigate/click on dynamic pages instead of guessing.',
    inputSchema: {
      selector: z.string().optional().describe('CSS selector to wait for.'),
      text: z.string().optional().describe('Substring of visible text to wait for.'),
      gone: z.boolean().optional().describe('With selector: wait until it is ABSENT instead of present.'),
      timeoutMs: z.number().optional().describe('Default 10000. Keep ≤ 30000.'),
      tabId: z.number().optional(),
    },
  },
  async ({ selector, text, gone, timeoutMs, tabId }) =>
    out(await call('wait_for', { selector, text, gone, timeoutMs, tabId }, (timeoutMs || 10000) + 5000)));

server.registerTool('console_capture',
  {
    description:
      'Record a tab\'s console output and uncaught errors — the console analogue of network_capture, no ' +
      'banner. action:"start" installs a MAIN-world hook and clears the buffer; action:"stop" returns ' +
      'the buffered {level, text, t} entries and drains them. The hook is lost on full page navigation ' +
      '(re-start after navigating).',
    inputSchema: {
      action: z.enum(['start', 'stop']),
      tabId: z.number().optional(),
    },
  },
  async ({ action, tabId }) => out(await call('console_capture', { action, tabId })));

server.registerTool('cookies',
  {
    description:
      'Read cookies (including httpOnly ones exec can\'t see) for a tab\'s URL or an explicit url. ' +
      'Returns {name, value, domain, path, secure, httpOnly, session, expires}. Read-only.',
    inputSchema: {
      tabId: z.number().optional().describe('Read cookies for this tab\'s URL. Omit to use the active tab.'),
      url: z.string().optional().describe('Explicit URL to read cookies for (overrides tabId).'),
    },
  },
  async ({ tabId, url }) => out(await call('cookies', { tabId, url })));

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
