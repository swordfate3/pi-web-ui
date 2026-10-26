import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';

// Whole mirror extension + real HTTP/WebSocket/Unix sockets. Only the SDK
// context/dispatch boundary is a facade; the actual Pi test counts provider calls.
for (const marker of ['b'.repeat(32), '']) {
  test(`mirror bootstrap ${marker ? 'before control publication' : 'with malformed empty marker'} refuses mutations`, { timeout: 15_000 }, async t => {
    const root = await mkdtemp('/tmp/web-bootstrap-');
    for (const dir of ['home', 'agent', 'run', 'sessions']) await mkdir(path.join(root, dir), { mode: 0o700 });
    const socketPath = path.join(root, 'run', 'control.sock');
    const reserve = net.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
    const port = (reserve.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reserve.close(() => resolve()));
    const env = { HOME: path.join(root, 'home'), PI_CODING_AGENT_DIR: path.join(root, 'agent'),
      PI_WEB_UI_HOST: '127.0.0.1', PI_WEB_UI_PORT: String(port), PI_WEB_UI_DISABLED: 'true',
      PI_WEB_UI_STATIC_DIR: path.resolve('dist'),
      PI_RUNTIME_RUN_ID: 'c'.repeat(32), PI_RUNTIME_CHILD_TOKEN: 'a'.repeat(64),
      PI_RUNTIME_EXTENSION_SOCKET: socketPath, PI_RUNTIME_PENDING_ACTIVATION: marker };
    const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    const events = new Map<string, Array<(event: any, ctx: any) => any>>();
    const commands = new Map<string, { handler: (args: string, ctx: any) => any }>();
    let release!: () => void, entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const listen = net.Server.prototype.listen;
    const delayed = t.mock.method(net.Server.prototype, 'listen', function (this: net.Server, ...args: any[]) {
      if (args[0] === socketPath && typeof args[1] === 'function') {
        const ready = args[1];
        args[1] = () => { entered(); void resume.then(ready); };
      }
      return Reflect.apply(listen, this, args);
    });
    let ws: WebSocket | undefined, starting: Promise<unknown> | undefined;
    let ctx: any;
    t.after(async () => {
      release(); await starting;
      ws?.terminate();
      for (const handler of events.get('session_shutdown') ?? []) await handler({ reason: 'quit' }, ctx);
      delayed.mock.restore();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    });
    const { SessionManager, createEventBus } = await import('@earendil-works/pi-coding-agent');
    const sessionFile = path.join(root, 'sessions', 'saved.jsonl');
    await writeFile(sessionFile, [
      { type: 'session', version: 3, id: 'bootstrap-session', cwd: root, timestamp: '2026-10-26T00:00:00.000Z' },
      { type: 'message', id: 'saved-leaf', parentId: null, timestamp: '2026-10-26T00:00:00.000Z', message: { role: 'user', content: 'saved text', timestamp: 1 } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
    const sessions = SessionManager.open(sessionFile, path.dirname(sessionFile));
    let dispatches = 0, thinking = 'off';
    const pi = {
      events: createEventBus(),
      on(name: string, handler: (event: any, ctx: any) => any) { events.set(name, [...(events.get(name) ?? []), handler]); },
      registerCommand(name: string, command: { handler: (args: string, ctx: any) => any }) { commands.set(name, command); },
      getThinkingLevel: () => thinking, setThinkingLevel: (level: string) => { thinking = level; },
      getSessionName: () => 'bootstrap', getCommands: () => [],
      sendUserMessage: () => { dispatches++; },
    };
    ctx = { cwd: root, sessionManager: sessions, model: { provider: 'fixture', id: 'deterministic', reasoning: true },
      modelRegistry: { getAvailable: () => [] }, ui: { notify() {}, setStatus() {} },
      isIdle: () => true, hasPendingMessages: () => false, getContextUsage: () => undefined };
    const module = `../extensions/mirror-server.ts?bootstrap=${marker || 'empty'}`;
    (await import(module)).default(pi);
    const firstStart = events.get('session_start')![0];
    starting = Promise.resolve(firstStart({ reason: 'startup' }, ctx));
    if (marker) await reached; else await starting;
    // An actual command starts the real mirror while controller publication is
    // held. Do NOT substitute prepared=true: removing fallback must break this.
    await commands.get('webui-start')!.handler('', ctx);
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await once(ws, 'open');
    let sequence = 0;
    const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
      const id = String(++sequence);
      const timer = setTimeout(() => reject(Error('Web reply deadline')), 2000);
      const receive = (data: any) => {
        const reply = JSON.parse(data.toString());
        if (reply.type !== 'res' || reply.id !== id) return;
        clearTimeout(timer); ws!.off('message', receive); resolve(reply);
      };
      ws!.on('message', receive); ws!.send(JSON.stringify({ type: 'req', id, method, params }));
    });
    for (const [method, params] of [['prompt', { message: 'must not dispatch' }], ['set_thinking_level', { level: 'low' }]] as const) {
      const reply = await request(method, params);
      assert.equal(reply.ok, false); assert.match(reply.error, /preparing to restart/);
    }
    assert.equal(dispatches, 0); assert.equal(thinking, 'off');
    assert.equal(sessions.getSessionId(), 'bootstrap-session'); assert.equal(sessions.getLeafId(), 'saved-leaf');
    assert.equal((await request('get_state', {})).ok, true);
    release(); await starting;
    assert.equal((await request('prompt', { message: 'still pending after publication' })).ok, false);
    assert.equal(dispatches, 0);
  });
}
