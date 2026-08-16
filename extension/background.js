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
      const format = p.format || (p.html ? 'html' : 'text');
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        args: [p.selector || null, format],
        func: (selector, format) => {
          const el = selector ? document.querySelector(selector) : document.documentElement;
          if (!el) return null;
          if (format === 'html') return el.outerHTML;
          if (format !== 'markdown') return el.innerText || el.textContent || '';
          // Lightweight, dependency-free DOM → Markdown of the main content.
          const scope = selector ? el : (document.querySelector('main') || document.querySelector('article') || document.body);
          if (!scope) return '';
          const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'NAV', 'ASIDE', 'FOOTER', 'FORM', 'SVG', 'TEMPLATE', 'IFRAME']);
          const ser = (node) => {
            let out = '';
            for (const child of node.childNodes) {
              if (child.nodeType === 3) { out += child.textContent.replace(/\s+/g, ' '); continue; }
              if (child.nodeType !== 1) continue;
              const tag = child.tagName;
              if (SKIP.has(tag)) continue;
              let hidden = false;
              try { const s = getComputedStyle(child); hidden = s.display === 'none' || s.visibility === 'hidden'; } catch {}
              if (hidden) continue;
              if (/^H[1-6]$/.test(tag)) { out += '\n\n' + '#'.repeat(+tag[1]) + ' ' + child.innerText.trim() + '\n\n'; continue; }
              if (tag === 'P') { out += '\n\n' + ser(child).trim() + '\n\n'; continue; }
              if (tag === 'BR') { out += '\n'; continue; }
              if (tag === 'HR') { out += '\n\n---\n\n'; continue; }
              if (tag === 'A') { const h = child.getAttribute('href'); const t = child.innerText.trim(); out += h && t ? '[' + t + '](' + h + ')' : t; continue; }
              if (tag === 'STRONG' || tag === 'B') { out += '**' + ser(child).trim() + '**'; continue; }
              if (tag === 'EM' || tag === 'I') { out += '*' + ser(child).trim() + '*'; continue; }
              if (tag === 'CODE' && child.closest('pre') === null) { out += '`' + child.innerText + '`'; continue; }
              if (tag === 'PRE') { out += '\n\n```\n' + child.innerText.replace(/\n$/, '') + '\n```\n\n'; continue; }
              if (tag === 'LI') { out += '\n- ' + ser(child).trim().replace(/\n/g, ' '); continue; }
              if (tag === 'UL' || tag === 'OL') { out += '\n' + ser(child) + '\n'; continue; }
              if (tag === 'IMG') { const alt = child.getAttribute('alt') || ''; const src = child.getAttribute('src') || ''; out += alt && src ? '![' + alt + '](' + src + ')' : ''; continue; }
              if (tag === 'BLOCKQUOTE') { out += '\n\n> ' + ser(child).trim().replace(/\n+/g, '\n> ') + '\n\n'; continue; }
              out += ser(child);
              if (tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE' || tag === 'TR') out += '\n';
            }
            return out;
          };
          return ser(scope).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        },
      });
      return res?.result;
    }

    case 'snapshot': {
      const tabId = p.tabId ?? (await activeTabId());
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        args: [p.selector || null, p.interactiveOnly !== false],
        func: (rootSel, interactiveOnly) => {
          let counter = 0;
          const CAP = 2000;
          const SIMPLE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
          const LANDMARK = new Set(['MAIN', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM', 'SECTION']);
          const visible = (el) => {
            if (el.getAttribute('aria-hidden') === 'true') return false;
            let s; try { s = getComputedStyle(el); } catch { return true; }
            if (s.display === 'none' || s.visibility === 'hidden') return false;
            const r = el.getBoundingClientRect();
            return !(r.width === 0 && r.height === 0);
          };
          const roleOf = (el) => {
            const explicit = el.getAttribute('role');
            if (explicit) return explicit;
            const tag = el.tagName;
            if (tag === 'A') return 'link';
            if (tag === 'BUTTON') return 'button';
            if (tag === 'INPUT') {
              const t = (el.getAttribute('type') || 'text').toLowerCase();
              if (t === 'checkbox') return 'checkbox';
              if (t === 'radio') return 'radio';
              if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
              if (t === 'search') return 'searchbox';
              if (t === 'hidden') return 'hidden';
              return 'textbox';
            }
            if (tag === 'SELECT') return 'combobox';
            if (tag === 'TEXTAREA') return 'textbox';
            if (tag === 'MAIN') return 'main';
            if (tag === 'NAV') return 'navigation';
            if (tag === 'HEADER') return 'banner';
            if (tag === 'FOOTER') return 'contentinfo';
            if (tag === 'FORM') return 'form';
            if (/^H[1-6]$/.test(tag)) return 'heading';
            return tag.toLowerCase();
          };
          const accName = (el) => {
            const al = el.getAttribute('aria-label');
            if (al && al.trim()) return al.trim();
            const lb = el.getAttribute('aria-labelledby');
            if (lb) {
              const txt = lb.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? n.innerText : ''; }).join(' ').trim();
              if (txt) return txt;
            }
            if (el.id) { try { const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (lab && lab.innerText.trim()) return lab.innerText.trim(); } catch {} }
            const wrap = el.closest && el.closest('label');
            if (wrap && wrap.innerText.trim()) return wrap.innerText.trim();
            for (const a of ['placeholder', 'title', 'alt', 'value']) { const v = el.getAttribute(a); if (v && v.trim()) return v.trim(); }
            return (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120);
          };
          const interactive = (el) => {
            if (SIMPLE.has(el.tagName)) return !(el.tagName === 'A' && !el.hasAttribute('href'));
            if (el.tagName === 'SUMMARY') return true;
            if (el.hasAttribute('role')) return true;
            if (el.hasAttribute('onclick')) return true;
            if (el.getAttribute('contenteditable') === 'true') return true;
            return false;
          };
          const lines = [];
          const root = rootSel ? document.querySelector(rootSel) : document.body;
          if (!root) return null;
          const walk = (el, depth) => {
            for (const child of Array.from(el.children)) {
              if (counter >= CAP) return;
              if (!visible(child)) continue;
              const act = interactive(child);
              const isHead = /^H[1-6]$/.test(child.tagName);
              const isLand = LANDMARK.has(child.tagName);
              const roleName = act ? roleOf(child) : null;
              if (roleName === 'hidden') continue;
              const emit = act || (!interactiveOnly && (isLand || isHead));
              if (emit) {
                const ref = 'e' + (++counter);
                child.setAttribute('data-cb-ref', ref);
                const r = roleOf(child);
                const name = accName(child);
                const states = [];
                if (child.disabled) states.push('disabled');
                if (child.checked) states.push('checked');
                const exp = child.getAttribute('aria-expanded');
                if (exp) states.push('expanded=' + exp);
                const nameStr = name ? ' "' + name.replace(/"/g, "'") + '"' : '';
                const stateStr = states.length ? ' [' + states.join(', ') + ']' : '';
                lines.push('  '.repeat(depth) + '- ' + r + nameStr + ' [ref=' + ref + ']' + stateStr);
              }
              if (!(act && SIMPLE.has(child.tagName))) walk(child, emit ? depth + 1 : depth);
            }
          };
          walk(root, 0);
          const body = lines.join('\n');
          const note = counter >= CAP ? '\n… (truncated at ' + CAP + ' elements)' : '';
          return body ? body + note : '(no matching elements found)';
        },
      });
      return res?.result;
    }

    case 'click': {
      const tabId = p.tabId ?? (await activeTabId());
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        args: [p.ref || null, p.selector || null],
        func: (ref, selector) => {
          const sel = ref ? '[data-cb-ref="' + ref + '"]' : selector;
          if (!sel) return { ok: false, error: 'need ref or selector' };
          const el = document.querySelector(sel);
          if (!el) return { ok: false, error: 'not found: ' + sel };
          el.scrollIntoView({ block: 'center', inline: 'center' });
          el.click();
          return { ok: true, clicked: sel };
        },
      });
      return res?.result;
    }

    case 'fill': {
      const tabId = p.tabId ?? (await activeTabId());
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        args: [p.ref || null, p.selector || null, String(p.value ?? ''), !!p.submit],
        func: (ref, selector, value, submit) => {
          const sel = ref ? '[data-cb-ref="' + ref + '"]' : selector;
          if (!sel) return { ok: false, error: 'need ref or selector' };
          const el = document.querySelector(sel);
          if (!el) return { ok: false, error: 'not found: ' + sel };
          el.focus();
          if (el.isContentEditable) {
            el.textContent = value;
          } else {
            // Use the native setter so React/Vue value trackers notice the change.
            const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const desc = Object.getOwnPropertyDescriptor(proto, 'value');
            if (desc && desc.set && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) desc.set.call(el, value);
            else el.value = value;
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          if (submit) {
            const form = el.form || (el.closest && el.closest('form'));
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            if (form) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); }
          }
          return { ok: true, filled: sel };
        },
      });
      return res?.result;
    }

    case 'hover': {
      const tabId = p.tabId ?? (await activeTabId());
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        args: [p.ref || null, p.selector || null],
        func: (ref, selector) => {
          const sel = ref ? '[data-cb-ref="' + ref + '"]' : selector;
          if (!sel) return { ok: false, error: 'need ref or selector' };
          const el = document.querySelector(sel);
          if (!el) return { ok: false, error: 'not found: ' + sel };
          el.scrollIntoView({ block: 'center' });
          const r = el.getBoundingClientRect();
          const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
          for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
            const Ctor = type.startsWith('pointer') && typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent;
            el.dispatchEvent(new Ctor(type, opts));
          }
          return { ok: true, hovered: sel };
        },
      });
      return res?.result;
    }

    case 'wait_for': {
      const tabId = p.tabId ?? (await activeTabId());
      const timeoutMs = p.timeoutMs || 10000;
      const start = Date.now();
      const check = async () => {
        try {
          const [r] = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            args: [p.selector || null, p.text || null, !!p.gone],
            func: (selector, text, gone) => {
              let found;
              if (selector) found = !!document.querySelector(selector);
              else if (text) found = (document.body ? document.body.innerText : '').includes(text);
              else found = document.readyState === 'complete';
              return gone ? !found : found;
            },
          });
          return r && r.result;
        } catch { return false; }
      };
      while (Date.now() - start < timeoutMs) {
        if (await check()) return { ok: true, waitedMs: Date.now() - start };
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error('wait_for timed out after ' + timeoutMs + 'ms');
    }

    case 'console_capture': {
      const tabId = p.tabId ?? (await activeTabId());
      if (p.action === 'start') {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: () => {
            if (window.__cbConsoleInstalled) { window.__cbConsole = []; return; }
            window.__cbConsoleInstalled = true;
            window.__cbConsole = [];
            const CAP = 1000;
            const push = (level, args) => {
              try {
                if (window.__cbConsole.length >= CAP) return;
                const text = args.map((a) => { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); } }).join(' ').slice(0, 2000);
                window.__cbConsole.push({ level, text, t: Date.now() });
              } catch {}
            };
            for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
              const orig = console[m].bind(console);
              console[m] = (...args) => { push(m, args); orig(...args); };
            }
            window.addEventListener('error', (e) => push('error', [(e.message || 'error') + ' @ ' + (e.filename || '') + ':' + (e.lineno || '')]));
            window.addEventListener('unhandledrejection', (e) => push('error', ['unhandledrejection: ' + ((e.reason && e.reason.message) || e.reason)]));
          },
        });
        return { ok: true, capturing: true };
      }
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => { const logs = window.__cbConsole || []; window.__cbConsole = []; return logs; },
      });
      const logs = (res && res.result) || [];
      return { count: logs.length, logs };
    }

    case 'cookies': {
      let url = p.url;
      if (!url) {
        const tabId = p.tabId ?? (await activeTabId());
        const tab = await chrome.tabs.get(tabId);
        url = tab.url;
      }
      const cookies = await chrome.cookies.getAll({ url });
      return {
        url,
        count: cookies.length,
        cookies: cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, session: c.session, expires: c.expirationDate })),
      };
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
