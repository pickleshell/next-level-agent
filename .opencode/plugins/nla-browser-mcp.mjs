import { spawn } from 'node:child_process';
import net from 'node:net';

export class BrowserError extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}

// MCP stdio uses newline-delimited JSON-RPC. No shell or inherited secrets.
export class BrowserMcpClient {
  constructor({ command, socket, environment = {}, timeout_ms = 30000, cwd, max_bytes = 2 * 1024 * 1024 }) {
    if ((!Array.isArray(command) || !command.length || command.some(x => typeof x !== 'string' || !x)) && typeof socket !== 'string') throw new BrowserError('NOT_CONFIGURED');
    this.command = command; this.environment = environment; this.timeout = timeout_ms;
    this.socket = socket; this.cwd = cwd; this.maxBytes = max_bytes; this.pending = new Map(); this.nextID = 0;
    this.buffer = ''; this.closed = false;
  }
  async start() {
    if (this.process || this.closed) throw new BrowserError('UNREACHABLE');
    const inherited = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'DISPLAY', 'XDG_RUNTIME_DIR', 'SYSTEMROOT'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    if (this.socket) {
      const socket = await new Promise((resolve, reject) => {
        const client = net.createConnection(this.socket);
        client.once('connect', () => resolve(client));
        client.once('error', reject);
      });
      this.process = {
        stdin: socket, stdout: socket, socket, exitCode: null, signalCode: null,
        stderr: { on: () => {} },
        once: (event, handler) => socket.once(event === 'exit' ? 'close' : event, handler),
        kill: () => socket.destroy(),
      };
    } else this.process = spawn(this.command[0], this.command.slice(1), { cwd: this.cwd, shell: false, env: { ...inherited, ...this.environment }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', chunk => this.receive(chunk));
    // Drain stderr without recording possible credentials or page content.
    this.process.stderr.on('data', () => {});
    this.process.stdin.on('error', () => this.fail());
    this.process.once('error', () => this.fail());
    this.process.once('exit', () => this.fail());
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'nla-browser', version: '1' } });
    this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const response = await this.request('tools/list', {});
    if (!Array.isArray(response.tools)) throw new BrowserError('UNSUPPORTED_CAPABILITY');
    this.tools = response.tools.map(t => t.name);
    return this.tools;
  }
  receive(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > this.maxBytes) { this.fail('RESOURCE_EXHAUSTED'); this.process.kill(); return; }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { this.fail(); this.process.kill(); return; }
      if (message.method && message.id !== undefined) {
        const reply = message.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Unsupported client request' } };
        this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply }) + '\n');
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new BrowserError('UNSUPPORTED_CAPABILITY'));
      else pending.resolve(message.result);
    }
  }
  request(method, params) {
    if (this.closed || !this.process) return Promise.reject(new BrowserError('UNREACHABLE'));
    const id = ++this.nextID;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new BrowserError('UNREACHABLE', 'Browser backend request timed out'));
        // A timed-out interaction has an unknown outcome; never resend it.
        this.fail(); this.process.kill();
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async call(name, args) {
    if (!this.tools?.includes(name)) throw new BrowserError('UNSUPPORTED_CAPABILITY');
    const result = await this.request('tools/call', { name, arguments: args });
    if (result?.isError) {
      const message = String(result.content?.[0]?.text || 'Browser backend operation failed').slice(0, 1000);
      // A strict locator error is an operation error, not transport loss.
      // Keep unknown backend failures fail-closed.
      const code = /Error: (?:locator\.[A-Za-z]+: (?:Error: )?)?strict mode violation:/.test(message)
        ? 'AMBIGUOUS_LOCATOR' : 'UNREACHABLE';
      throw new BrowserError(code, message);
    }
    return result;
  }
  fail(code = 'UNREACHABLE') {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new BrowserError(code)); }
    this.pending.clear();
  }
  async close() {
    this.fail();
    const child = this.process;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (child.socket) { child.socket.end(); child.socket.destroy(); return; }
    child.stdin.end(); child.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}
