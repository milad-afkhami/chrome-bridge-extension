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
const server = new McpServer({ name: 'chrome-bridge', version: '0.5.0' });

server.registerTool('ping',
  {
    description:
      'Health check for the bridge — never throws. Returns {ok, server:{role,port}, extension:{...}}. ' +
      'If the extension is connected it round-trips to it and reports {pong, version, connectedSince, ' +
      'commandCount, lastAction, tabCount, now}; if not, ok:false and extension.connected:false with ' +
      'the reason. Use this to confirm the extension is live before driving a page (and to tell ' +
      '"server up, extension down" apart from a real failure).',
    inputSchema: {},
  },
  async () => {
    const serverInfo = { role, port: PORT };
    try {
      const ext = await call('ping', {}, 5000);
      return out({ ok: true, server: serverInfo, extension: ext });
    } catch (e) {
      return out({ ok: false, server: serverInfo, extension: { connected: false, error: String((e && e.message) || e) } });
    }
  });

server.registerTool('list_tabs',
  { description: 'List open browser tabs as [{tabId, url, title, active}]. Read-only; never changes focus.', inputSchema: {} },
  async () => out(await call('list_tabs')));

server.registerTool('exec',
  {
    description:
      'Run JavaScript in a tab and return its value (must be JSON-serializable). Runs in the page ' +
      'MAIN world via chrome.scripting — no debugger banner, and does NOT focus or raise the tab. ' +
      'The code is an async function body: use `return ...` and top-level `await`. ' +
      'If a page\'s strict Content-Security-Policy blocks the default eval-based exec (symptom: null ' +
      'on GitHub/Google/some banks), set viaDebugger:true to run it through the DevTools protocol ' +
      '(Runtime.evaluate), which CSP does not restrict — at the cost of briefly showing the ' +
      '"debugging this browser" banner.',
    inputSchema: {
      code: z.string().describe('JavaScript to run, e.g. "return document.title" or "document.querySelector(\'#x\').click()"'),
      tabId: z.number().describe('Target tab id from list_tabs (required).'),
      viaDebugger: z.boolean().optional().describe('Run via the debugger (Runtime.evaluate) to bypass strict CSP. Shows the debugging banner briefly.'),
    },
  },
  async ({ code, tabId, viaDebugger }) => out(await call('exec', { code, tabId, viaDebugger }, viaDebugger ? 60000 : 30000)));

server.registerTool('read',
  {
    description:
      'Read a tab\'s content without focusing it. format:"text" (default) = visible innerText; ' +
      '"html" = outerHTML; "markdown" = the main/article content as clean Markdown (headings, links, ' +
      'lists, code) — great for reading an article without HTML bloat. Optional CSS selector to read a ' +
      'single element instead of the whole document. Works everywhere incl. strict-CSP sites (no eval).',
    inputSchema: {
      tabId: z.number().describe('Target tab id from list_tabs (required).'),
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
      tabId: z.number().describe('Target tab id from list_tabs (required).'),
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
      tabId: z.number().describe('Target tab id from list_tabs (required).'),
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
      tabId: z.number().describe('Target tab id from list_tabs (required).'),
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
      tabId: z.number().describe('Target tab id from list_tabs (required).'),
    },
  },
  async ({ ref, selector, tabId }) => out(await call('hover', { ref, selector, tabId })));

server.registerTool('wait_for',
  {
    description:
      'Wait until a condition holds in a tab, polling in-page every 250ms (no banner). Provide ONE of: ' +
      'selector (wait until it appears, or disappears if gone:true), text (wait until the page ' +
      'contains it), or networkIdle:true (wait until no requests have been in flight for ~500ms — the ' +
      'way to let a page settle after navigate/click before reading it). With none, waits for ' +
      'document.readyState === "complete". Returns {ok, waitedMs} or errors on timeout.',
    inputSchema: {
      selector: z.string().optional().describe('CSS selector to wait for.'),
      text: z.string().optional().describe('Substring of visible text to wait for.'),
      gone: z.boolean().optional().describe('With selector: wait until it is ABSENT instead of present.'),
      networkIdle: z.boolean().optional().describe('Wait until the tab has had no in-flight requests for idleMs.'),
      idleMs: z.number().optional().describe('Quiet window for networkIdle (default 500ms).'),
      timeoutMs: z.number().optional().describe('Default 10000. Keep ≤ 30000.'),
      tabId: z.number().describe('Target tab id from list_tabs (required).'),
    },
  },
  async ({ selector, text, gone, networkIdle, idleMs, timeoutMs, tabId }) =>
    out(await call('wait_for', { selector, text, gone, networkIdle, idleMs, timeoutMs, tabId }, (timeoutMs || 10000) + 5000)));

server.registerTool('console_capture',
  {
    description:
      'Record a tab\'s console output and uncaught errors — the console analogue of network_capture, no ' +
      'banner. action:"start" installs a MAIN-world hook and clears the buffer; action:"stop" returns ' +
      'the buffered {level, text, t} entries and drains them. The hook is lost on full page navigation ' +
      '(re-start after navigating).',
    inputSchema: {
      action: z.enum(['start', 'stop']),
      tabId: z.number().describe('Target tab id from list_tabs (required).'),
    },
  },
  async ({ action, tabId }) => out(await call('console_capture', { action, tabId })));

server.registerTool('cookies',
  {
    description:
      'Read cookies (including httpOnly ones exec can\'t see) for a tab\'s URL or an explicit url. ' +
      'Returns {name, value, domain, path, secure, httpOnly, session, expires}. Read-only.',
    inputSchema: {
      tabId: z.number().optional().describe('Read cookies for this tab\'s URL. Provide this or url.'),
      url: z.string().optional().describe('Explicit URL to read cookies for (overrides tabId).'),
    },
  },
  async ({ tabId, url }) => out(await call('cookies', { tabId, url })));

server.registerTool('navigate',
  {
    description: 'Navigate a tab to a URL in the background (does not focus/raise it). Requires a tabId — use list_tabs to target an existing tab, or open_tab to start fresh. Never touches your focused tab.',
    inputSchema: { url: z.string(), tabId: z.number().describe('Target tab id from list_tabs or open_tab (required).') },
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
      'Capture a PNG of a tab and return it as an image. Requires a tabId (from list_tabs). Two modes:\n' +
      '• Default (no viewport params): captures the tab at its real window size via captureVisibleTab. If ' +
      'that tab is not frontmost, it is briefly flashed to the front to render, then the previous tab is ' +
      'restored (a short flicker — this mode touches focus, only for a moment).\n' +
      '• Device-emulated (pass width AND height): renders off-screen at an emulated mobile/device viewport ' +
      'via the DevTools Protocol — no focus change and no resize of the real window. Use this for ' +
      'mobile-viewport UI QA. This mode briefly shows Chrome\'s "being debugged" banner while attached ' +
      '(the same trade-off as exec viaDebugger / upload_file); it detaches immediately after.\n' +
      'Pass selector to clip the capture to a single element (a card/modal), off-screen and focus-free; ' +
      'combine it with width/height to shoot one component at a mobile viewport. selector also uses CDP ' +
      '(the banner shows briefly).',
    inputSchema: {
      tabId: z.number().describe('Target tab id from list_tabs (required).'),
      width: z.number().optional().describe('Emulated viewport width (CSS px). Provide with height for a device-emulated capture.'),
      height: z.number().optional().describe('Emulated viewport height (CSS px).'),
      deviceScaleFactor: z.number().optional().describe('Device pixel ratio for the emulated capture (default 2).'),
      mobile: z.boolean().optional().describe('Emulate a mobile device (default true when width/height given).'),
      fullPage: z.boolean().optional().describe('Capture the full scrollable page instead of just the viewport.'),
      selector: z.string().optional().describe('CSS selector to clip the capture to a single element (scrolled into view first).'),
    },
  },
  async ({ tabId, width, height, deviceScaleFactor, mobile, fullPage, selector }) => {
    const r = await call('screenshot', { tabId, width, height, deviceScaleFactor, mobile, fullPage, selector });
    const b64 = String((r && r.dataUrl) || '').replace(/^data:image\/png;base64,/, '');
    if (!b64) return out(r);
    return { content: [{ type: 'image', data: b64, mimeType: 'image/png' }] };
  });

server.registerTool('press_key',
  {
    description:
      'Press a keyboard key in a tab via the DevTools protocol — the keyboard primitive fill lacks. ' +
      'Use for Escape (close a modal), Enter (submit), Tab (move focus / a11y checks), arrows, ' +
      'Backspace/Delete, Home/End/PageUp/PageDown, or a single printable character. Optionally focus ' +
      'an element first with selector. Dispatches a real keydown+keyup (and a char for printable keys) ' +
      'so the page\'s handlers fire. Shows the "being debugged" banner briefly, then detaches.',
    inputSchema: {
      key: z.string().describe('Key name (Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space) or a single character.'),
      modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional().describe('Modifier keys held during the press.'),
      selector: z.string().optional().describe('CSS selector to focus before pressing (optional).'),
      tabId: z.number().describe('Target tab id from list_tabs (required).'),
    },
  },
  async ({ key, modifiers, selector, tabId }) => out(await call('press_key', { key, modifiers, selector, tabId })));

server.registerTool('select',
  {
    description:
      'Set a native <select> dropdown by option value, visible label, or index, then fire input+change ' +
      'so frameworks (React/Vue) react. This is what fill can\'t do (fill only handles ' +
      'input/textarea/contenteditable). Runs in the page — no focus change, no banner. Provide exactly ' +
      'one of value / label / index.',
    inputSchema: {
      ref: z.string().optional().describe('A ref from snapshot, e.g. "e9".'),
      selector: z.string().optional().describe('CSS selector of the <select> (use if you have no ref).'),
      value: z.string().optional().describe('Match the option by its value attribute.'),
      label: z.string().optional().describe('Match the option by its visible text.'),
      index: z.number().optional().describe('Match the option by its zero-based index.'),
      tabId: z.number().describe('Target tab id from list_tabs (required).'),
    },
  },
  async ({ ref, selector, value, label, index, tabId }) => out(await call('select', { ref, selector, value, label, index, tabId })));

server.registerTool('emulate_media',
  {
    description:
      'Force a tab\'s CSS media state for theme/motion/print QA: colorScheme "dark"|"light"|"no-preference" ' +
      '(prefers-color-scheme), reducedMotion "reduce"|"no-preference" (prefers-reduced-motion), and/or ' +
      'media "screen"|"print". The override PERSISTS across later navigate/exec/screenshot calls on that ' +
      'tab because it holds a DevTools session open — so the "being debugged" banner stays up until you ' +
      'call emulate_media {reset:true} (which clears the override and detaches). Repeat calls just update ' +
      'the override; they do not stack.',
    inputSchema: {
      colorScheme: z.enum(['light', 'dark', 'no-preference']).optional().describe('Force prefers-color-scheme.'),
      reducedMotion: z.enum(['reduce', 'no-preference']).optional().describe('Force prefers-reduced-motion.'),
      media: z.enum(['screen', 'print']).optional().describe('Force the media type.'),
      reset: z.boolean().optional().describe('Clear the override and detach the held session.'),
      tabId: z.number().describe('Target tab id from list_tabs (required).'),
    },
  },
  async ({ colorScheme, reducedMotion, media, reset, tabId }) => out(await call('emulate_media', { colorScheme, reducedMotion, media, reset, tabId })));

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
      tabId: z.number().describe('Target tab id from list_tabs (required).'),
    },
  },
  async ({ selector, filePaths, tabId }) => out(await call('upload_file', { selector, filePaths, tabId }, 60000)));

server.registerTool('network_capture',
  {
    description:
      'Record network requests (URL, method, resource type, status, timing) via the webRequest API ' +
      '— no banner. action:"start" begins buffering (optionally filtered to one tabId); ' +
      'action:"stop" returns the buffered requests and clears the buffer. ' +
      'Set bodies:true on start to ALSO capture response bodies via the debugger (Network domain): ' +
      'this REQUIRES a tabId (the debugger targets one tab), shows the "debugging this browser" ' +
      'banner for the capture, and returns each request with {status, mimeType, body, base64Encoded, ' +
      'bodyBytes, bodyTruncated} (bodies capped at 64KB each, 100 requests). Without bodies, prefer ' +
      'the default webRequest path (no banner, all tabs).',
    inputSchema: {
      action: z.enum(['start', 'stop']),
      tabId: z.number().optional().describe('On start: capture only this tab. Required when bodies:true.'),
      bodies: z.boolean().optional().describe('Capture response bodies via the debugger (needs tabId; shows the banner).'),
    },
  },
  async ({ action, tabId, bodies }) => out(await call('network_capture', { action, tabId, bodies }, 60000)));

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
