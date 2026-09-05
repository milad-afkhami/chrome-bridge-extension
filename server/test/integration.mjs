// Hermetic integration test for the MCP server plumbing.
// Spawns the real server on a throwaway port, attaches a FAKE extension (so no
// real Chrome is needed), drives it through a real MCP stdio client, and asserts
// the new surface: the `ping` health tool, and forwarding of `viaDebugger` (exec)
// and `bodies` (network_capture). Run: `node test/integration.mjs` from server/.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'index.js');
const PORT = 9333; // throwaway; avoids the real bridge on 9223

let passed = 0;
const fails = [];
function check(name, cond) { if (cond) { passed++; console.log('  ✅ ' + name); } else { fails.push(name); console.log('  ❌ ' + name); } }
const textOf = (r) => r.content?.[0]?.text ?? '';
const jsonOf = (r) => JSON.parse(textOf(r));

// A fake extension: records every action it receives, replies with canned results.
const received = [];
function connectFakeExt(handlers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.on('open', () => ws.send(JSON.stringify({ hello: 'ext' })));
    ws.on('error', reject);
    ws.on('message', (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.hello) return;
      received.push({ action: m.action, params: m.params });
      let result, error;
      try { result = handlers[m.action] ? handlers[m.action](m.params) : { echoed: m.params }; }
      catch (e) { error = String(e.message); }
      ws.send(JSON.stringify({ id: m.id, result, error }));
    });
    // resolve once the hello has surely been processed
    setTimeout(() => resolve(ws), 300);
  });
}

const handlers = {
  ping: () => ({ pong: true, version: '0.4.0', tabCount: 3, commandCount: 7, connectedSince: 1, lastAction: 'ping', lastActionAt: 2, now: 3 }),
  exec: (p) => (p.viaDebugger ? 'DBG:' + p.code : 'MAIN:' + p.code),
  network_capture: (p) => (p.action === 'start'
    ? { ok: true, capturing: true, tabId: p.tabId, bodies: !!p.bodies }
    : { count: 1, bodies: true, requests: [{ url: 'https://x/api', status: 200, body: '{"a":1}', base64Encoded: false, bodyBytes: 7 }] }),
};

const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env: { ...process.env, BRIDGE_PORT: String(PORT) } });
const client = new Client({ name: 'test', version: '1.0.0' });

let extWs;
try {
  await client.connect(transport);
  extWs = await connectFakeExt(handlers);

  // 1. tool registration + schemas
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  console.log('\nTool registration:');
  check('ping tool registered', !!byName.ping);
  check('exec exposes viaDebugger param', !!byName.exec?.inputSchema?.properties?.viaDebugger);
  check('network_capture exposes bodies param', !!byName.network_capture?.inputSchema?.properties?.bodies);

  // 2. ping — healthy (extension connected)
  console.log('\nping (healthy):');
  const ping = jsonOf(await client.callTool({ name: 'ping', arguments: {} }));
  check('ping ok:true', ping.ok === true);
  check('ping reports server role', ping.server?.role === 'hub' && ping.server?.port === PORT);
  check('ping round-trips to extension (pong)', ping.extension?.pong === true && ping.extension?.version === '0.4.0');

  // 3. exec forwards viaDebugger
  console.log('\nexec viaDebugger forwarding:');
  const e1 = textOf(await client.callTool({ name: 'exec', arguments: { code: 'return 1', tabId: 1, viaDebugger: true } }));
  check('viaDebugger:true reaches extension', received.some((r) => r.action === 'exec' && r.params.viaDebugger === true));
  check('viaDebugger result routed back', e1 === 'DBG:return 1');
  const e2 = textOf(await client.callTool({ name: 'exec', arguments: { code: 'return 2', tabId: 1 } }));
  check('default exec stays MAIN world', e2 === 'MAIN:return 2');
  // tabId is required on exec (v0.4.0 contract): omitting it must be rejected, not forwarded.
  const noTab = await client.callTool({ name: 'exec', arguments: { code: 'return 3' } }).catch((e) => ({ threw: String(e?.message || e) }));
  check('exec without tabId is rejected by schema', noTab.threw != null || noTab.isError === true);

  // 4. network_capture forwards bodies
  console.log('\nnetwork_capture bodies forwarding:');
  const nStart = jsonOf(await client.callTool({ name: 'network_capture', arguments: { action: 'start', tabId: 5, bodies: true } }));
  check('bodies:true + tabId reach extension', received.some((r) => r.action === 'network_capture' && r.params.bodies === true && r.params.tabId === 5));
  check('start echoes bodies:true', nStart.bodies === true && nStart.tabId === 5);
  const nStop = jsonOf(await client.callTool({ name: 'network_capture', arguments: { action: 'stop' } }));
  check('stop returns request with a body', nStop.requests?.[0]?.body === '{"a":1}');

  // 5. ping — degraded (extension gone) must NOT throw
  console.log('\nping (extension down):');
  extWs.close();
  await new Promise((r) => setTimeout(r, 200));
  const ping2 = jsonOf(await client.callTool({ name: 'ping', arguments: {} }));
  check('ping never throws when ext down', ping2.ok === false);
  check('ping reports extension.connected:false', ping2.extension?.connected === false);
} catch (e) {
  fails.push('harness error: ' + (e?.stack || e));
  console.log('  ❌ harness error:', e?.stack || e);
} finally {
  try { extWs?.close(); } catch {}
  try { await client.close(); } catch {}
}

console.log(`\n${passed} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
