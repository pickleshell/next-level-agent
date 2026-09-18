import { BrowserError, BrowserMcpClient } from './nla-browser-mcp.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Reviewed backend program. The public API accepts data, never JavaScript.
// This function is serialized into MCP's code tool; only NLA chooses the code.
async function operation(page, input) {
  const context = page.context();
  const origin = url => /^https?:\/\/[^/?#]+/.exec(url)?.[0] || null;
  const allowed = url => input.origins.includes(origin(url));
  const safeURL = url => url.split(/[?#]/)[0];
  const state = context.__nlaBrowser;
  if (input.kind === 'preflight') {
    if (state) throw new Error('Context already initialized');
    if (context.pages().length !== 1 || page.url() !== 'about:blank' || (await context.cookies()).length) throw new Error('Context is not fresh');
    const s = { console: [], network: [], redirects: {}, dialogs: 0, blocks: 0 };
    context.__nlaBrowser = s;
    await context.route('**/*', async route => {
      const request = route.request();
      if (!allowed(request.url()) || (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !input.permissions.external_mutation)) {
        s.blocks++; await route.abort(); return;
      }
      try {
        // Do not let a redirect escape the policy before checking it.
        // Streaming transports are deliberately unsupported by this adapter.
        const response = await route.fetch({ maxRedirects: 0, timeout: input.timeout });
        if (response.status() >= 300 && response.status() < 400) {
          const location = response.headers().location;
          if (location) s.redirects[request.url()] = location;
          await route.abort(); return;
        }
        s.network.push({ method: request.method(), url: safeURL(request.url()), status: response.status() });
        s.network = s.network.slice(-50);
        await route.fulfill({ response });
      } catch { s.blocks++; await route.abort().catch(() => {}); }
    });
    if (typeof context.routeWebSocket !== 'function') throw new Error('WebSocket policy unavailable');
    await context.routeWebSocket('**/*', socket => { s.blocks++; socket.close(); });
    const attach = p => {
      p.on('console', m => { s.console.push({ type: m.type() }); s.console = s.console.slice(-50); });
      p.on('pageerror', () => { s.console.push({ type: 'exception' }); s.console = s.console.slice(-50); });
      p.on('dialog', d => { s.dialogs++; void d.dismiss(); });
      p.on('download', d => { if (!input.permissions.downloads) void d.cancel(); });
    };
    attach(page); context.on('page', attach);
    context.setDefaultTimeout(input.timeout);
    context.setDefaultNavigationTimeout(input.timeout);
    await context.clearPermissions();
    await page.setViewportSize({ width: 1280, height: 720 });
    return { backend: 'playwright-mcp', engine: context.browser()?.browserType().name(), version: context.browser()?.version(), isolated: true, operations: ['navigate', 'observe', 'click', 'fill', 'select', 'press', 'tabs', 'screenshot', 'upload', 'download', 'check'], streaming: false };
  }
  if (!state) throw new Error('Preflight required');
  if (input.kind === 'status') return { status: 'PASS', reachable: true, url: safeURL(page.url()) };
  if (input.tab !== undefined) {
    page = context.pages()[input.tab];
    if (!page) throw new Error('Invalid tab');
  }
  const locator = spec => {
    if (!spec || typeof spec !== 'object') throw new Error('Locator required');
    if (spec.role) return page.getByRole(spec.role, { name: spec.name, exact: true });
    if (spec.label) return page.getByLabel(spec.label, { exact: true });
    if (spec.test_id) return page.getByTestId(spec.test_id);
    if (spec.text) return page.getByText(spec.text, { exact: true });
    throw new Error('Semantic locator required');
  };
  if (input.kind === 'navigate') {
    const url = input.url;
    if (!allowed(url)) return { status: 'BLOCKED', reason: 'POLICY_DENIED' };
    delete state.redirects[url];
    try { await page.goto(url, { waitUntil: 'domcontentloaded' }); }
    catch { if (!state.redirects[url]) throw new Error('Navigation unavailable'); }
    if (state.redirects[url]) return { status: 'PASS', redirect: { base: url, location: state.redirects[url] } };
    if (!allowed(page.url())) return { status: 'BLOCKED', reason: 'POLICY_DENIED' };
    return { status: 'PASS', url: safeURL(page.url()), title: (await page.title()).slice(0, 1000) };
  }
  if (input.kind === 'tabs') {
    const pages = context.pages();
    if (input.action === 'new') {
      if (pages.length >= 4) return { status: 'BLOCKED', reason: 'RESOURCE_EXHAUSTED' };
      await context.newPage();
    } else if (input.action === 'close') {
      if (pages.length <= 1 || !pages[input.index]) throw new Error('Invalid tab');
      await pages[input.index].close();
    }
    return { status: 'PASS', tabs: context.pages().map((p, index) => ({ index, url: safeURL(p.url()) })) };
  }
  if (input.kind === 'observe') {
    const result = { status: 'PASS', url: safeURL(page.url()), title: (await page.title()).slice(0, 1000) };
    if (input.locator) {
      const l = locator(input.locator);
      result.count = await l.count(); result.visible = await l.isVisible();
      if (result.count === 1) { result.text = (await l.innerText()).slice(0, input.limit); result.enabled = await l.isEnabled(); }
    } else result.text = (await page.locator('body').innerText()).slice(0, input.limit);
    result.console = state.console; result.network = state.network;
    result.dialogs = state.dialogs; result.policy_blocks = state.blocks;
    return result;
  }
  if (input.kind === 'screenshot') {
    await page.screenshot({ path: input.artifact, fullPage: false, type: 'png' });
    return { status: 'PASS', artifact: input.artifact, url: safeURL(page.url()) };
  }
  if (input.kind === 'check') {
    const started = Date.now(); let observed; let passed = false;
    do {
      if (input.check === 'url_equals') { observed = safeURL(page.url()); passed = observed === input.expected; }
      else if (input.check === 'no_console_errors') { observed = state.console.filter(x => ['error', 'exception'].includes(x.type)).length; passed = observed === 0; }
      else if (input.check === 'no_dialogs') { observed = state.dialogs; passed = observed === 0; }
      else try {
        const l = locator(input.locator);
        if (input.check === 'element_visible') { observed = await l.isVisible(); passed = observed === true; }
        else if (input.check === 'element_enabled') { observed = await l.isEnabled({ timeout: 200 }); passed = observed === true; }
        else { observed = (await l.innerText({ timeout: 200 })).slice(0, input.limit); passed = input.check === 'text_equals' ? observed === input.expected : observed.includes(input.expected); }
      } catch { observed = null; passed = false; }
      if (passed || Date.now() - started >= input.wait_ms) break;
      // Bounded condition polling, never an arbitrary task-level sleep.
      await page.waitForTimeout(50);
    } while (true);
    return { status: passed ? 'PASS' : 'FAIL', check: input.check, expected: input.expected ?? true, observed };
  }
  const l = locator(input.locator);
  if (await l.getAttribute('type') === 'password' && !input.permissions.authentication) return { status: 'BLOCKED', reason: 'POLICY_DENIED' };
  if (input.kind === 'fill') await l.fill(input.text);
  else if (input.kind === 'click') await l.click();
  else if (input.kind === 'select') await l.selectOption(input.values);
  else if (input.kind === 'press') await l.press(input.key);
  else if (input.kind === 'upload') await l.setInputFiles(input.files);
  else if (input.kind === 'download') {
    const promise = page.waitForEvent('download');
    await l.click(); const download = await promise; await download.saveAs(input.artifact);
  } else throw new Error('Unsupported operation');
  return { status: 'PASS', operation: input.kind, url: safeURL(page.url()) };
}

export class PlaywrightMcpBackend {
  constructor(config) {
    this.config = config;
    this.outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-browser-backend-'));
    this.client = new BrowserMcpClient({ ...config, cwd: this.outputDir, command: [...config.command, '--block-service-workers', '--snapshot-mode', 'none', '--output-dir', this.outputDir] });
  }
  async start(policy) {
    await this.client.start();
    this.codeTool = ['browser_run_code_unsafe', 'browser_run_code'].find(name => this.client.tools.includes(name));
    if (!this.codeTool) throw new BrowserError('UNSUPPORTED_CAPABILITY');
    this.policy = policy;
    return this.invoke({ kind: 'preflight' });
  }
  async invoke(data) {
    const redirects = [];
    for (let i = 0; i < 10; i++) {
      const result = await this.perform(data);
      if (data.kind !== 'navigate' || !result.redirect) return data.kind === 'navigate' ? { ...result, redirects } : result;
      let url;
      try { url = new URL(result.redirect.location, result.redirect.base); } catch { return { status: 'BLOCKED', reason: 'POLICY_DENIED' }; }
      if (url.username || url.password || !this.policy.origins.includes(url.origin)) return { status: 'BLOCKED', reason: 'POLICY_DENIED' };
      const previous = new URL(data.url); redirects.push(previous.origin + previous.pathname);
      data = { ...data, url: url.href };
    }
    return { status: 'BLOCKED', reason: 'RESOURCE_EXHAUSTED' };
  }
  async perform(data) {
    const input = { ...data, origins: this.policy.origins, permissions: this.policy.permissions, timeout: this.config.action_timeout_ms || 5000, limit: 12000 };
    const code = `async (page) => ({nla_browser_result: await (${operation.toString()})(page, ${JSON.stringify(input)})})`;
    const response = await this.client.call(this.codeTool, { code });
    for (const block of response.content || []) {
      if (block.type !== 'text') continue;
      const section = block.text.includes('### Result\n') ? block.text.split('### Result\n')[1].split('\n### ')[0] : block.text;
      for (const line of section.split('\n')) {
        if (!line.startsWith('{"nla_browser_result":')) continue;
        try { return JSON.parse(line).nla_browser_result; } catch { throw new BrowserError('UNREACHABLE'); }
      }
    }
    throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Backend did not return structured Browser evidence');
  }
  async close() {
    let timer;
    try {
      if (this.client.tools?.includes('browser_close') && !this.client.closed) await Promise.race([
        this.client.call('browser_close', {}),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new BrowserError('UNREACHABLE')), 2000); }),
      ]);
    } catch {} finally {
      clearTimeout(timer); await this.client.close();
      fs.rmSync(this.outputDir, { recursive: true, force: true });
    }
  }
}
