import { BrowserError, BrowserMcpClient } from './nla-browser-mcp.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Reviewed backend program. The public API accepts data, never JavaScript.
// This function is serialized into MCP's code tool; only NLA chooses the code.
export async function operation(page, input) {
  const context = page.context();
  const origin = value => {
    const match = /^(https?|wss?):\/\/([^/?#]+)/i.exec(value);
    if (!match) return null;
    const protocol = match[1].toLowerCase() === 'wss' ? 'https' : match[1].toLowerCase() === 'ws' ? 'http' : match[1].toLowerCase();
    return protocol + '://' + match[2];
  };
  const allowed = url => input.origins.includes(origin(url));
  const secretSelectors = ['input[type="password"]', '[data-secret]', '[data-sensitive]', '[data-private]', '[name*="token" i]', '[name*="api-key" i]', '[name*="apikey" i]', '[name*="secret" i]', '[name*="auth" i]', '[id*="token" i]', '[id*="api-key" i]', '[id*="apikey" i]', '[id*="secret" i]', '[id*="auth" i]'];
  const secretSelector = secretSelectors.join(',');
  const isSecretRegion = async l => l.evaluate((element, selector) =>
    element.matches(selector)
      || Boolean(element.closest(selector))
      || Boolean(element.querySelector(selector)),
  secretSelector);
  const secretText = async l => (await isSecretRegion(l))
    ? '[REDACTED]'
    : (await l.innerText()).slice(0, input.limit);
  // A check must not use its result channel to bypass the observation policy.
  // For secret regions, compare inside the page and return only the verdict.
  const checkedText = async (l, expected, contains) => {
    try {
      const passed = await l.evaluate((element, args) => {
        const secret = element.matches(args.selector)
          || Boolean(element.closest(args.selector))
          || Boolean(element.querySelector(args.selector));
        if (secret) {
          const value = element.innerText;
          return { secret: true, passed: args.contains ? value.includes(args.expected) : value === args.expected };
        }
        const observed = element.innerText.slice(0, args.limit);
        return { secret: false, observed, passed: args.contains ? observed.includes(args.expected) : observed === args.expected };
      }, { expected, contains, selector: secretSelector, limit: input.limit });
      return passed.secret ? { observed: '[REDACTED]', passed: passed.passed, secret: true } : passed;
    } catch { return { observed: '[REDACTED]', passed: false, secret: true }; }
  };
  const bodyText = async () => (await page.locator('body').evaluate((body, selector) => {
    const clone = body.cloneNode(true);
    clone.querySelectorAll(selector).forEach(node => node.replaceWith(document.createTextNode('[REDACTED]')));
    clone.querySelectorAll('script,style,template,noscript').forEach(node => node.remove()); return clone.innerText;
  }, secretSelector)).slice(0, input.limit);
  const safeURL = url => url.split(/[?#]/)[0];
  const state = context.__nlaBrowser;
  if (input.kind === 'preflight') {
    if (state) throw new Error('Context already initialized');
    if (context.pages().length !== 1 || page.url() !== 'about:blank' || (await context.cookies()).length) throw new Error('Context is not fresh');
    const s = { console: [], network: [], redirects: {}, dialogs: 0, blocks: 0, crashed: new Set() };
    context.__nlaBrowser = s;
    // Match only HTTP(S) requests. WebSocket Upgrade is a separate browser
    // transport and must never enter the HTTP route/fetch pipeline.
    const routeHTTP = async route => {
      const request = route.request();
      if (!allowed(request.url()) || (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !input.permissions.external_mutation)) {
        s.blocks++; await route.abort(); return;
      }
      try {
        // Continue approved requests through the browser network stack. This
        // preserves SSE and WebSocket semantics and avoids Chromium treating
        // route.fetch/fulfill loopback responses as private-network hops.
        await route.continue();
      } catch { s.blocks++; await route.abort().catch(() => {}); }
    };
    await context.route('http://**/*', routeHTTP);
    await context.route('https://**/*', routeHTTP);
    const attach = p => {
      p.on('console', m => { s.console.push({ type: m.type() }); s.console = s.console.slice(-50); });
      p.on('pageerror', () => { s.console.push({ type: 'exception' }); s.console = s.console.slice(-50); });
      p.on('crash', () => s.crashed.add(p));
      p.on('dialog', d => { s.dialogs++; void d.dismiss(); });
      p.on('download', d => { if (!input.permissions.downloads) void d.cancel(); });
      p.on('response', response => {
        const type = response.headers()['content-type'] || '';
        if (type.includes('text/event-stream')) s.sse_responses = (s.sse_responses || 0) + 1;
        if (response.status() >= 300 && response.status() < 400) {
          const location = response.headers()['location'];
          if (location) s.redirects[response.url()] = location;
        }
        s.network.push({ method: response.request().method(), url: safeURL(response.url()), status: response.status() });
        s.network = s.network.slice(-50);
      });
    };
    attach(page); context.on('page', attach);
    context.setDefaultTimeout(input.timeout);
    context.setDefaultNavigationTimeout(input.timeout);
    await context.clearPermissions();
    await page.setViewportSize({ width: 1280, height: 720 });
    return { backend: 'playwright-mcp', engine: context.browser()?.browserType().name(), version: context.browser()?.version(), isolated: true, operations: ['navigate', 'observe', 'click', 'fill', 'select', 'press', 'tabs', 'screenshot', 'upload', 'download', 'check'], streaming: true };
  }
  if (!state) throw new Error('Preflight required');
  if (input.kind === 'status') return { status: 'PASS', reachable: true, url: safeURL(page.url()) };
  if (input.tab !== undefined) {
    page = context.pages()[input.tab];
    if (!page) throw new Error('Invalid tab');
  }
  if (page.isClosed?.() || state.crashed?.has(page)) throw new Error('Browser page is unavailable');
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
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
      if (response && response.status() >= 500) throw new Error('Navigation unavailable');
      if (page.url().startsWith('chrome-error://')) throw new Error('Navigation unavailable');
    }
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
      if (result.count === 1) { result.text = await secretText(l); result.enabled = await l.isEnabled(); }
    } else result.text = await bodyText();
    result.console = state.console; result.network = state.network;
    result.streaming = { sse_responses: state.sse_responses || 0, websocket_connections: state.websocket || 0, websocket_messages: state.websocket_messages || 0, websocket_closed: state.websocket_closed || 0 };
    result.dialogs = state.dialogs; result.policy_blocks = state.blocks;
    return result;
  }
  if (input.kind === 'screenshot') {
    // Report only regions that actually existed in the captured page. Returning
    // the static selector list would make evidence claim that absent regions
    // were masked, which is not a useful security fact.
    const masks = [];
    const secretRegionsMasked = [];
    for (const selector of secretSelectors) {
      const candidate = page.locator(selector);
      if (await candidate.count()) {
        masks.push(candidate);
        secretRegionsMasked.push(selector);
      }
    }
    await page.screenshot({ path: input.artifact, fullPage: false, type: 'png', mask: masks, maskColor: '#000000' });
    return { status: 'PASS', artifact: input.artifact, url: safeURL(page.url()), secret_regions_masked: secretRegionsMasked };
  }
  if (input.kind === 'check') {
    const deadline = Date.now() + (Number.isFinite(input.wait_ms) ? Math.min(10000, Math.max(0, input.wait_ms)) : 1000);
    let observed; let passed = false; let redactExpected = false;
    do {
      if (input.check === 'url_equals') { observed = safeURL(page.url()); passed = observed === input.expected; }
      else if (input.check === 'no_console_errors') { observed = state.console.filter(x => ['error', 'exception'].includes(x.type)).length; passed = observed === 0; }
      else if (input.check === 'no_dialogs') { observed = state.dialogs; passed = observed === 0; }
      else try {
        const l = locator(input.locator);
        if (input.check === 'element_visible') { observed = await l.isVisible(); passed = observed === true; }
        else if (input.check === 'element_enabled') { observed = await l.isEnabled({ timeout: 200 }); passed = observed === true; }
        else {
          const checked = await checkedText(l, input.expected, input.check === 'text_contains');
          observed = checked.observed; passed = checked.passed;
          redactExpected ||= checked.secret;
        }
      } catch {
        // A failed text read cannot prove that the locator was non-secret.
        redactExpected ||= ['text_equals', 'text_contains'].includes(input.check);
        observed = redactExpected ? '[REDACTED]' : null;
        passed = false;
      }
      if (passed || Date.now() >= deadline) break;
      // Bounded condition polling, never an arbitrary task-level sleep.
      await page.waitForTimeout(50);
    } while (true);
    const expected = typeof input.expected === 'string' && (redactExpected || observed === '[REDACTED]') ? '[REDACTED]' : input.expected ?? true;
    const safeObserved = redactExpected ? '[REDACTED]' : observed;
    return { status: passed ? 'PASS' : 'FAIL', check: input.check, expected, observed: safeObserved };
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
  return { status: 'PASS', operation: input.kind, url: safeURL(page.url()), artifact: input.kind === 'download' ? input.artifact : undefined };
}

export class PlaywrightMcpBackend {
  constructor(config) {
    this.config = config;
    this.outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-browser-backend-'));
    const command = config.socket ? undefined : [...config.command, '--block-service-workers', '--snapshot-mode', 'none', '--output-dir', this.outputDir];
    this.client = new BrowserMcpClient({ ...config, cwd: this.outputDir, command });
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
