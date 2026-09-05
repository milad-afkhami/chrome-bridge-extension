// LIVE end-to-end QA against the REAL (reloaded) extension.
// Spawns a controller (no BRIDGE_PORT → the live hub on 9223 owns the extension,
// this instance forwards to it), then exercises the three new features for real:
//   1. ping round-trips to the extension and reports v0.4.0 (proves the reload)
//   2. exec viaDebugger runs on a strict-CSP site where plain exec is blocked
//   3. network_capture bodies returns a real response body
// Needs: the extension reloaded to 0.4.0, Chrome running, internet.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'index.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0; const fails = [];
function check(name, cond, detail) { if (cond) { passed++; console.log('  ✅ ' + name); } else { fails.push(name); console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); } }

const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env: { ...process.env } });
const client = new Client({ name: 'live-qa', version: '1.0.0' });

// controller's link to the hub is async; retry calls that race it.
async function callTool(name, args = {}) {
  for (let i = 0; i < 8; i++) {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    if (/not reachable yet|starting up/.test(text)) { await sleep(400); continue; }
    return r.content?.[0]?.type === 'image' ? { image: true } : text;
  }
  throw new Error('controller could not reach hub');
}
const j = (t) => JSON.parse(t);

let scratch;
try {
  await client.connect(transport);
  await sleep(600); // let the controller connect to the hub

  // 1. ping — proves the extension is reloaded to 0.4.0
  console.log('\n1. ping / health:');
  const ping = j(await callTool('ping'));
  console.log('   ' + JSON.stringify(ping).slice(0, 300));
  check('ping ok:true', ping.ok === true);
  check('extension reloaded to 0.4.0', ping.extension?.version === '0.4.0', 'got ' + ping.extension?.version + ' (reload the extension at chrome://extensions)');
  check('ping reports tabCount', typeof ping.extension?.tabCount === 'number');

  if (ping.extension?.version !== '0.4.0') throw new Error('extension not reloaded — aborting live tests');

  // scratch tab for the CSP test (don't touch the user's real tabs)
  const opened = j(await callTool('open_tab', { url: 'https://github.com/', active: false }));
  scratch = opened.tabId;
  await callTool('wait_for', { tabId: scratch, text: 'GitHub', timeoutMs: 15000 });

  // 2. exec viaDebugger on a strict-CSP site (github) vs plain exec
  console.log('\n2. exec on strict-CSP (github.com):');
  const plain = await callTool('exec', { tabId: scratch, code: 'return document.title' });
  const dbg = await callTool('exec', { tabId: scratch, viaDebugger: true, code: 'return document.title' });
  console.log('   plain exec ->', JSON.stringify(plain));
  console.log('   viaDebugger ->', JSON.stringify(dbg));
  check('viaDebugger returns a real title on CSP site', typeof dbg === 'string' && /GitHub/i.test(dbg));
  check('viaDebugger computes in-page', j(await callTool('exec', { tabId: scratch, viaDebugger: true, code: 'return 6*7' })) === 42);
  // (plain exec being null/blocked is the motivation; we just log it, don't hard-assert,
  //  since some github routes relax CSP.)
  if (plain === 'null' || plain === '' ) console.log('   (plain exec blocked by CSP as expected)');

  // 3. network_capture with bodies — capture a real response body
  console.log('\n3. network_capture bodies:');
  await callTool('navigate', { tabId: scratch, url: 'https://example.com/' });
  await callTool('wait_for', { tabId: scratch, text: 'Example Domain', timeoutMs: 15000 });
  const started = j(await callTool('network_capture', { action: 'start', tabId: scratch, bodies: true }));
  check('start returns bodies:true', started.bodies === true && started.tabId === scratch);
  // trigger a request whose body we can recognise
  await callTool('exec', { tabId: scratch, code: "await fetch(location.href, {cache:'no-store'}); return 'ok'" });
  await sleep(800);
  const stopped = j(await callTool('network_capture', { action: 'stop' }));
  const withBody = (stopped.requests || []).filter((r) => r.body);
  console.log('   captured ' + (stopped.count) + ' requests, ' + withBody.length + ' with bodies');
  const hit = withBody.find((r) => /Example Domain/i.test(r.body));
  check('captured a response body', withBody.length > 0);
  check('a captured body has real content (Example Domain)', !!hit, 'sample: ' + JSON.stringify(withBody[0])?.slice(0, 160));
  check('the document body records status + mimeType', hit?.status === 200 && /html/.test(hit?.mimeType || ''), 'hit: ' + JSON.stringify(hit && { status: hit.status, mimeType: hit.mimeType, bodyBytes: hit.bodyBytes }));

  // bodies:true without tabId must be rejected (guard)
  console.log('\n4. guards:');
  const guard = await callTool('network_capture', { action: 'start', bodies: true });
  check('bodies without tabId is rejected', /requires a tabId/i.test(String(guard)));
} catch (e) {
  fails.push('harness: ' + (e?.message || e));
  console.log('  ❌ harness error:', e?.stack || e);
} finally {
  try { if (scratch) await callTool('close_tab', { tabId: scratch }); } catch {}
  try { await client.close(); } catch {}
}

console.log(`\n${passed} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
