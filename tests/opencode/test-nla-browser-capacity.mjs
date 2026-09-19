import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrowserCapability } from '../../.opencode/plugins/nla-browser.mjs';

const task = { goal: 'Check capacity', permissions: {}, origins: ['http://example.test'],
  success_criteria: [{ id: 'quiet', check: 'no_dialogs' }] };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const barrier = (count = 1) => {
  const entered = deferred(); const released = deferred();
  return { entered: entered.promise, release: released.resolve, async wait() {
    if (--count === 0) entered.resolve();
    await released.promise;
  } };
};

async function fixture(t, { max = 1, broker = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nla-capacity-'));
  const socketPath = path.join(root, 'broker.sock');
  const calls = []; const sockets = new Set(); const gates = [];
  const state = { fail: null, cleanupFails: false, hold: null, gate: null, factories: 0, closes: 0 };
  let sequence = 0;
  const pause = async stage => { if (state.hold === stage) await state.gate.wait(); };
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer); buffer = '';
      calls.push(request.op);
      void (async () => {
        await pause(request.op);
        const response = state.fail === request.op || (state.cleanupFails && request.op === 'destroy')
          ? { ok: false, error: `fixture ${request.op} failure` }
          : request.op === 'create'
            ? { ok: true, session: { session_id: `network-${++sequence}`, session_token: 'fixture-token' } }
            : request.op === 'launch' ? { ok: true, endpoint: '/unused-fixture.sock' } : { ok: true };
        socket.end(JSON.stringify(response) + '\n');
      })().catch(error => socket.destroy(error));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  const manager = new BrowserCapability({ root,
    config: { allowed_origins: task.origins, max_sessions: max, ...(broker ? { broker_socket: socketPath } : {}) },
    backendFactory: () => {
      state.factories++;
      if (state.fail === 'factory') throw new Error('fixture factory failure');
      return {
        async start() { await pause('start'); if (state.fail === 'start') throw new Error('fixture start failure'); return {}; },
        async close() { state.closes++; await pause('close'); if (state.cleanupFails || state.fail === 'close') throw new Error('fixture close failure'); },
      };
    },
  });
  clearInterval(manager.timer); // Tests drive expiry explicitly, without clock races.
  t.after(async () => {
    for (const gate of gates) gate.release();
    state.fail = null; state.cleanupFails = false;
    if (state.disposalError) await assert.rejects(manager.dispose(), error => error === state.disposalError);
    else await manager.dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { manager, state, calls, root,
    begin: (signal, overrides = {}, directory = root) => manager.begin({ ...task, ...overrides }, 'owner', directory, signal),
    hold(stage, count = 1) { state.hold = stage; state.gate = barrier(count); gates.push(state.gate); return state.gate; },
  };
}

for (const stage of ['create', 'launch', 'start']) {
  for (const max of [1, 2]) {
    test(`capacity ${max} includes concurrent ${stage} calls`, { timeout: 10000 }, async t => {
      const f = await fixture(t, { max }); const gate = f.hold(stage, max);
      const pending = Array.from({ length: max }, () => f.begin());
      await gate.entered;
      await assert.rejects(f.begin(), { code: 'RESOURCE_EXHAUSTED' });
      assert.equal(f.calls.filter(op => op === 'create').length, max);
      assert.equal(f.manager.sessions.size + f.manager.pendingSessions, max);
      gate.release();
      const sessions = await Promise.all(pending);
      assert.equal(f.manager.pendingSessions, 0);
      await assert.rejects(f.begin(), { code: 'RESOURCE_EXHAUSTED' });
      await f.manager.closeOwned(sessions[0].id, 'owner');
      await f.begin();
      assert.equal(f.manager.sessions.size, max);
    });
  }
}

for (const stage of ['create', 'launch', 'factory', 'start']) {
  test(`${stage} failure releases capacity and permits retry`, { timeout: 10000 }, async t => {
    const f = await fixture(t); f.state.fail = stage;
    await assert.rejects(f.begin(), new RegExp(`fixture ${stage} failure`));
    assert.equal(f.manager.pendingSessions, 0); assert.equal(f.manager.sessions.size, 0);
    assert.equal(f.calls.filter(op => op === 'destroy').length, stage === 'create' ? 0 : 1);
    assert.equal(f.state.closes, stage === 'start' ? 1 : 0);
    f.state.fail = null;
    await f.begin();
    assert.equal(f.manager.sessions.size, 1);
  });
}

for (const stage of ['create', 'launch', 'start']) {
  test(`cancellation during ${stage} releases capacity`, { timeout: 10000 }, async t => {
    const f = await fixture(t); const gate = f.hold(stage); const controller = new AbortController();
    const rejected = assert.rejects(f.begin(controller.signal), { code: 'CANCELLED' });
    await gate.entered; controller.abort(); gate.release(); await rejected;
    assert.equal(f.manager.pendingSessions, 0); assert.equal(f.manager.sessions.size, 0);
    assert.equal(f.calls.filter(op => op === 'destroy').length, 1);
    await f.begin();
  });
}

for (const stage of ['launch', 'factory', 'start']) {
  test(`${stage} failure holds capacity through observable failed cleanup`, { timeout: 10000 }, async t => {
    const f = await fixture(t); f.state.fail = stage; f.state.cleanupFails = true;
    const gate = f.hold('destroy');
    const rejected = assert.rejects(f.begin(), /Browser resource cleanup failed:.*fixture .* failure/);
    await gate.entered;
    await assert.rejects(f.begin(), { code: 'RESOURCE_EXHAUSTED' });
    assert.equal(f.calls.filter(op => op === 'create').length, 1);
    gate.release(); await rejected;
    assert.equal(f.manager.pendingSessions, 0); assert.equal(f.manager.sessions.size, 0);
    assert.ok(f.manager.diagnostics.some(d => d.event === 'browser_cleanup_failed' && d.reason.includes('fixture destroy failure')));
    f.state.fail = null; f.state.cleanupFails = false;
    await f.begin();
  });
}

test('direct backend startup is bounded; retained sessions resume at capacity', { timeout: 10000 }, async t => {
  const f = await fixture(t, { broker: false }); const gate = f.hold('start');
  const pending = f.begin(); await gate.entered;
  await assert.rejects(f.begin(), { code: 'RESOURCE_EXHAUSTED' });
  assert.equal(f.state.factories, 1); gate.release();
  const session = await pending;
  session.busy = false;
  assert.equal(await f.begin(undefined, { session_id: session.id }), session);
  assert.equal(f.state.factories, 1); assert.equal(f.manager.pendingSessions, 0);
});

test('artifact write failure releases capacity', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const blocked = path.join(f.root, 'evidence'); fs.writeFileSync(blocked, 'not a directory');
  await assert.rejects(f.begin(), { code: 'RESOURCE_EXHAUSTED' });
  assert.equal(f.manager.pendingSessions, 0); assert.equal(f.manager.sessions.size, 0);
  fs.unlinkSync(blocked);
  await f.begin();
});

test('post-start setup failure releases capacity', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.begin(undefined, {}, null), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.equal(f.manager.pendingSessions, 0); assert.equal(f.manager.sessions.size, 0);
  assert.equal(f.state.closes, 1);
  await f.begin();
});

test('cancellation preserves cleanup failure completed before startup returns', { timeout: 10000 }, async t => {
  const f = await fixture(t); const gate = f.hold('start'); const controller = new AbortController();
  const rejected = assert.rejects(f.begin(controller.signal), /Browser resource cleanup failed/);
  await gate.entered;
  const session = [...f.manager.sessions.values()][0];
  f.state.cleanupFails = true; controller.abort();
  await assert.rejects(session.cleanupPromise, /Browser resource cleanup failed/);
  assert.equal(f.manager.sessions.size, 0);
  gate.release(); await rejected;
  assert.equal(f.manager.pendingSessions, 0);
  f.state.cleanupFails = false;
  await f.begin();
});

for (const stage of ['create', 'launch', 'start']) {
  for (const cleanupFails of [false, true]) {
    test(`dispose drains ${stage} and ${cleanupFails ? 'reports failed' : 'awaits'} cleanup`, { timeout: 10000 }, async t => {
      const f = await fixture(t, { max: 2 }); const gate = f.hold(stage, 2);
      const expected = cleanupFails ? /Browser resource cleanup failed/ : { code: 'SESSION_CLOSED' };
      const pending = [assert.rejects(f.begin(), expected), assert.rejects(f.begin(), expected)];
      await gate.entered;
      f.state.cleanupFails = cleanupFails;
      let settled = false;
      const disposal = f.manager.dispose().finally(() => { settled = true; });
      const concurrent = f.manager.dispose();
      const failed = error => {
        assert.match(error.message, /Browser dispose failed:.*fixture destroy failure/);
        if (f.state.disposalError) assert.equal(error, f.state.disposalError);
        f.state.disposalError = error;
        return true;
      };
      const results = cleanupFails
        ? [assert.rejects(disposal, failed), assert.rejects(concurrent, failed)]
        : [disposal, concurrent];
      await assert.rejects(f.begin(), { code: 'SESSION_CLOSED' });
      assert.equal(settled, false, 'dispose must wait for provisioning');
      assert.equal(f.state.closes, 0, 'close must not race backend start');
      assert.equal(f.calls.filter(op => op === 'create').length, 2);
      const cleanup = f.hold('destroy', 2);
      gate.release();
      await cleanup.entered;
      assert.equal(settled, false, 'dispose must wait for resource cleanup');
      await assert.rejects(f.begin(), { code: 'SESSION_CLOSED' });
      cleanup.release();
      await Promise.all([...pending, ...results]);
      assert.equal(settled, true);
      assert.equal(f.manager.pendingSessions, 0);
      assert.equal(f.manager.sessions.size, 0);
      assert.equal(f.manager.children.size, 0);
      assert.equal(f.manager.begins.size, 0);
      assert.equal(f.calls.filter(op => op === 'destroy').length, 2);
      assert.equal(f.calls.filter(op => op === 'launch').length, stage === 'create' ? 0 : 2);
      assert.equal(f.state.factories, stage === 'start' ? 2 : 0);
      assert.equal(f.state.closes, stage === 'start' ? 2 : 0);
      if (cleanupFails) assert.equal(f.manager.diagnostics.filter(d => d.event === 'browser_cleanup_failed').length, 2);
      await assert.rejects(f.begin(), { code: 'SESSION_CLOSED' });
      if (cleanupFails) await assert.rejects(f.manager.dispose(), error => error === f.state.disposalError);
      else await f.manager.dispose();
      await assert.rejects(f.begin(), { code: 'SESSION_CLOSED' });
    });
  }
}

for (const fail of [null, 'close']) {
  test(`dispose drains direct startup with ${fail || 'successful'} cleanup`, { timeout: 10000 }, async t => {
    const f = await fixture(t, { broker: false }); const startup = f.hold('start');
    const pending = assert.rejects(f.begin(), fail ? /fixture close failure/ : { code: 'SESSION_CLOSED' });
    await startup.entered;
    f.state.fail = fail;
    let settled = false;
    const disposal = f.manager.dispose().finally(() => { settled = true; });
    const result = fail ? assert.rejects(disposal, error => {
      assert.match(error.message, /Browser dispose failed:.*fixture close failure/);
      f.state.disposalError = error; return true;
    }) : disposal;
    const cleanup = f.hold('close'); startup.release();
    await cleanup.entered;
    assert.equal(settled, false);
    cleanup.release(); await Promise.all([pending, result]);
    assert.equal(f.state.closes, 1);
    assert.equal(f.manager.sessions.size, 0);
    assert.equal(f.manager.pendingSessions, 0);
    await assert.rejects(f.begin(), { code: 'SESSION_CLOSED' });
  });
}

test('dispose rejects begin queued before provisioning and retained-session resume', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const session = await f.begin(); session.busy = false;
  const queued = assert.rejects(f.begin(), { code: 'SESSION_CLOSED' });
  const resumed = assert.rejects(f.begin(undefined, { session_id: session.id }), { code: 'SESSION_CLOSED' });
  await Promise.all([f.manager.dispose(), queued, resumed]);
  await assert.rejects(f.begin(undefined, { session_id: session.id }), { code: 'SESSION_CLOSED' });
  assert.equal(f.calls.filter(op => op === 'create').length, 1);
  assert.equal(f.calls.filter(op => op === 'destroy').length, 1);
  assert.equal(f.state.closes, 1);
});

test('dispose rejects begin awaiting reaping before reserving capacity', { timeout: 10000 }, async t => {
  const f = await fixture(t); const session = await f.begin();
  session.busy = false; session.expires = 0;
  const cleanup = f.hold('close');
  const pending = assert.rejects(f.begin(), { code: 'SESSION_CLOSED' });
  await cleanup.entered;
  const disposal = f.manager.dispose();
  cleanup.release(); await Promise.all([pending, disposal]);
  assert.equal(f.calls.filter(op => op === 'create').length, 1);
  assert.equal(f.state.closes, 1);
  assert.equal(f.manager.sessions.size, 0);
  assert.equal(f.manager.pendingSessions, 0);
});

for (const stage of ['create', 'launch', 'start']) {
  test(`dispose retains ${stage} failure without claiming cleanup failed`, { timeout: 10000 }, async t => {
    const f = await fixture(t); const gate = f.hold(stage); f.state.fail = stage;
    const pending = assert.rejects(f.begin(), new RegExp(`fixture ${stage} failure`));
    await gate.entered;
    const disposal = assert.rejects(f.manager.dispose(), error => {
      assert.equal(error.message, `Browser dispose failed: fixture ${stage} failure`);
      f.state.disposalError = error; return true;
    });
    gate.release(); await Promise.all([pending, disposal]);
    assert.equal(f.manager.sessions.size, 0);
    assert.equal(f.manager.pendingSessions, 0);
    assert.equal(f.calls.filter(op => op === 'destroy').length, stage === 'create' ? 0 : 1);
    assert.equal(f.state.closes, stage === 'start' ? 1 : 0);
    assert.equal(f.manager.diagnostics.length, 0, 'successful cleanup must not report a cleanup failure');
    await assert.rejects(f.manager.dispose(), error => error === f.state.disposalError);
    await assert.rejects(f.begin(), { code: 'SESSION_CLOSED' });
  });
}

test('dispose retains registered-session cleanup failure across repeated calls', { timeout: 10000 }, async t => {
  const f = await fixture(t); await f.begin(); f.state.cleanupFails = true;
  await assert.rejects(f.manager.dispose(), error => {
    assert.match(error.message, /Browser dispose cleanup failed:.*fixture close failure.*fixture destroy failure/);
    f.state.disposalError = error; return true;
  });
  await assert.rejects(f.manager.dispose(), error => error === f.state.disposalError);
  assert.equal(f.manager.sessions.size, 0);
  assert.equal(f.state.closes, 1);
  assert.equal(f.calls.filter(op => op === 'destroy').length, 1);
});
