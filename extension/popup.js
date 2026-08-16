const $ = (id) => document.getElementById(id);
const root = $('cb');

function ago(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  return Math.round(m / 60) + 'h ago';
}

function dur(ts) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

function render(r) {
  const ok = !!(r && r.connected);
  root.classList.toggle('cb-off', !ok);
  $('statusWord').textContent = ok ? 'connected' : 'disconnected';
  if (r && r.port) $('url').textContent = '127.0.0.1:' + r.port;
  $('uptime').textContent = ok ? dur(r && r.connectedSince) : '—';
  $('last').textContent = r && r.lastAction ? r.lastAction + ' · ' + ago(r.lastActionAt) : '—';
  $('count').textContent = r && r.commandCount != null ? r.commandCount : '—';

  // Light up the tool that ran most recently.
  const lastTool = r && r.lastAction;
  document.querySelectorAll('.cb-tool').forEach((el) => {
    el.classList.toggle('on', ok && el.dataset.t === lastTool);
  });
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'status' }, render);
  chrome.tabs.query({}, (tabs) => { $('tabs').textContent = tabs ? tabs.length : '—'; });
}

$('reconnect').onclick = () =>
  chrome.runtime.sendMessage({ type: 'reconnect' }, () => setTimeout(refresh, 400));

refresh();
setInterval(refresh, 1000);
