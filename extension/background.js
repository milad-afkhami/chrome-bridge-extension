// Chrome Bridge — background service worker.
// Auto-connects to the local MCP server's WebSocket and executes commands.
// Design rule: NEVER activate/raise a tab or window. Every op targets a tabId
// and runs in the background so it never steals your focus.

const PORT = 9223;
const URL = `ws://127.0.0.1:${PORT}`;
let ws = null;
let connected = false;
let connectedSince = null;
let lastAction = null;
let lastActionAt = null;
let commandCount = 0;
// Restore counters so the popup survives service-worker suspension.
try {
  chrome.storage.local.get(['commandCount', 'lastAction', 'lastActionAt'], (d) => {
    if (typeof d.commandCount === 'number') commandCount = d.commandCount;
    if (d.lastAction) { lastAction = d.lastAction; lastActionAt = d.lastActionAt; }
  });
} catch {}

function connect() {
  try { ws = new WebSocket(URL); } catch { scheduleReconnect(); return; }

  ws.onopen = () => { connected = true; connectedSince = Date.now(); try { ws.send(JSON.stringify({ hello: 'ext' })); } catch {} console.log('[chrome-bridge] connected'); };
  ws.onclose = () => { connected = false; connectedSince = null; scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch {} };

  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const { id, action, params } = msg;
    try {
      const result = await handle(action, params || {});
      ws.send(JSON.stringify({ id, result }));
    } catch (e) {
      ws.send(JSON.stringify({ id, error: String((e && e.message) || e) }));
    }
  };
}

let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 1500);
}

connect();

// Reconnect triggers that survive MV3 service-worker suspension.
// An alarm re-wakes the (possibly suspended) worker to retry; the top-level
// connect() above runs again each time the worker is revived by any event.
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
try { chrome.alarms.create('cb-keepalive', { periodInMinutes: 0.5 }); } catch {}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'cb-keepalive' && (!ws || ws.readyState !== WebSocket.OPEN)) connect();
});
// While the worker is alive, retry quickly too.
setInterval(() => {
  if (!ws || ws.readyState === WebSocket.CLOSED) connect();
}, 5000);

async function activeTabId() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) throw new Error('No active tab found');
  return t.id;
}

// ---- network capture (webRequest; no banner, no response bodies) ----
let capturing = false;
let captureTabId = null;
let captured = [];
const inflight = new Map();
function netStart(d) {
  if (!capturing || (captureTabId != null && d.tabId !== captureTabId)) return;
  inflight.set(d.requestId, { url: d.url, method: d.method, type: d.type, tabId: d.tabId, started: d.timeStamp });
}
function netDone(d) {
  if (!capturing) return;
  const r = inflight.get(d.requestId); inflight.delete(d.requestId);
  if (r) captured.push({ ...r, status: d.statusCode, fromCache: d.fromCache, ms: Math.round(d.timeStamp - r.started) });
}
function netErr(d) {
  if (!capturing) return;
  const r = inflight.get(d.requestId); inflight.delete(d.requestId);
  if (r) captured.push({ ...r, error: d.error, ms: Math.round(d.timeStamp - r.started) });
}
try {
  chrome.webRequest.onBeforeRequest.addListener(netStart, { urls: ['<all_urls>'] });
  chrome.webRequest.onCompleted.addListener(netDone, { urls: ['<all_urls>'] });
  chrome.webRequest.onErrorOccurred.addListener(netErr, { urls: ['<all_urls>'] });
} catch (e) { console.warn('[chrome-bridge] webRequest unavailable', e); }

// ---- debugger helper (only used by upload_file) ----
function dbg(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params || {}, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message)); else resolve(res);
    });
  });
}

async function handle(action, p) {
  lastAction = action;
  lastActionAt = Date.now();
  commandCount++;
  try { chrome.storage.local.set({ commandCount, lastAction, lastActionAt }); } catch {}
  switch (action) {
    case 'list_tabs': {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({ tabId: t.id, url: t.url, title: t.title, active: t.active }));
    }

    case 'navigate': {
      const tabId = p.tabId ?? (await activeTabId());
      // No { active: true } → tab updates in place without being focused/raised.
      await chrome.tabs.update(tabId, { url: p.url });
      return { ok: true, tabId, url: p.url };
    }

    case 'exec': {
      const tabId = p.tabId ?? (await activeTabId());
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        args: [String(p.code)],
        func: (code) => {
          // AsyncFunction so the caller's code can use `return` and `await`.
          const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
          return AsyncFunction(code)(); // executeScript awaits the returned promise
        },
      });
      return res?.result;
    }

    case 'read': {
      const tabId = p.tabId ?? (await activeTabId());
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        args: [p.selector || null, !!p.html],
        func: (selector, html) => {
          const el = selector ? document.querySelector(selector) : document.documentElement;
          if (!el) return null;
          return html ? el.outerHTML : (el.innerText || el.textContent || '');
        },
      });
      return res?.result;
    }

    case 'open_tab': {
      if (p.newWindow || p.incognito) {
        const win = await chrome.windows.create({ url: p.url || 'about:blank', incognito: !!p.incognito, focused: !!p.active });
        const t = win.tabs && win.tabs[0];
        return { tabId: t && t.id, windowId: win.id, incognito: win.incognito };
      }
      const t = await chrome.tabs.create({ url: p.url || 'about:blank', active: !!p.active });
      return { tabId: t.id, windowId: t.windowId, active: t.active };
    }

    case 'close_tab': {
      await chrome.tabs.remove(p.tabId);
      return { ok: true };
    }

    case 'screenshot': {
      const tabId = p.tabId ?? (await activeTabId());
      const tab = await chrome.tabs.get(tabId);
      const [prev] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      const flash = !tab.active; // only touch focus if we must render a background tab
      if (flash) { await chrome.tabs.update(tabId, { active: true }); await new Promise((r) => setTimeout(r, 180)); }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      if (flash && prev) await chrome.tabs.update(prev.id, { active: true });
      return { dataUrl };
    }

    case 'upload_file': {
      const tabId = p.tabId ?? (await activeTabId());
      const target = { tabId };
      await chrome.debugger.attach(target, '1.3');
      try {
        const doc = await dbg(target, 'DOM.getDocument', { depth: -1 });
        const found = await dbg(target, 'DOM.querySelector', { nodeId: doc.root.nodeId, selector: p.selector });
        if (!found || !found.nodeId) throw new Error('file input not found: ' + p.selector);
        await dbg(target, 'DOM.setFileInputFiles', { nodeId: found.nodeId, files: p.filePaths });
        return { ok: true, files: p.filePaths };
      } finally {
        try { await chrome.debugger.detach(target); } catch {}
      }
    }

    case 'network_capture': {
      if (p.action === 'start') {
        capturing = true; captureTabId = p.tabId ?? null; captured = []; inflight.clear();
        return { ok: true, capturing: true, tabId: captureTabId };
      }
      capturing = false;
      const requests = captured; captured = []; inflight.clear();
      return { count: requests.length, requests };
    }

    default:
      throw new Error('Unknown action: ' + action);
  }
}

// Popup status/reconnect.
chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  const snapshot = () => ({ connected, connectedSince, lastAction, lastActionAt, commandCount, port: PORT });
  if (req?.type === 'status') sendResponse(snapshot());
  else if (req?.type === 'reconnect') { try { ws && ws.close(); } catch {} connect(); sendResponse(snapshot()); }
  return true;
});
