// Standalone control: exercises the existing Playwright MCP backend without
// BrowserCapability, NLA tasks, or Browser role routing.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { BrowserMcpClient } from '../../.opencode/plugins/nla-browser-mcp.mjs';

const events = [];
const server = http.createServer((req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<p id="result">Waiting</p>'); return; }
  res.statusCode = 404; res.end();
});
server.on('upgrade', (req, socket) => {
  events.push({ event: 'upgrade', url: req.url, origin: req.headers.origin, upgrade: req.headers.upgrade, connection: req.headers.connection });
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') { events.push({ event: 'reject' }); socket.destroy(); return; }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  events.push({ event: 'open', status: 101 });
  const payload = Buffer.from('server-message');
  socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  socket.on('data', data => { events.push({ event: 'message_from_browser', bytes: data.length }); });
  setTimeout(() => { socket.write(Buffer.from([0x88, 0x00])); socket.end(); events.push({ event: 'close', code: 1000 }); }, 100);
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const command = [process.env.NODE_BIN || '/home/next/.local/share/nla-browser/node_modules/node/bin/node', process.env.MCP_CLI || '/home/next/.local/share/nla-browser/node_modules/@playwright/mcp/cli.js', '--isolated', '--headless', '--executable-path', process.env.BROWSER_EXECUTABLE || '/home/next/.cache/ms-playwright/chromium-1232/chrome-linux64/chrome'];
command.push('--block-service-workers', '--snapshot-mode', 'none', '--output-dir', '/tmp/nla-ws-standalone-output');
const client = new BrowserMcpClient({ command, cwd: '/tmp', timeout_ms: 30000 });
try {
  await client.start();
  const tool = client.tools.find(name => name === 'browser_run_code_unsafe' || name === 'browser_run_code');
  const code = `async (page) => { await page.goto('${origin}/'); const result = await page.evaluate(() => new Promise(resolve => { const ws = new WebSocket('ws://' + location.host + '/socket'); const seen = []; ws.onopen = () => { seen.push('open'); ws.send('browser-message'); }; ws.onmessage = event => { seen.push('message:' + event.data); document.body.dataset.result = event.data; }; ws.onerror = () => seen.push('error'); ws.onclose = event => { seen.push('close:' + event.code); resolve(seen); }; })); return { url: '${origin}/', events: result, dom: await page.locator('body').getAttribute('data-result') }; }`;
  const raw = await client.request('tools/call', { name: tool, arguments: { code } });
  console.log(JSON.stringify({ origin, events, backend_result: raw }, null, 2));
} finally { await client.close(); await new Promise(resolve => server.close(resolve)); }
