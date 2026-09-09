import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { startCapture, type RunningCapture } from '../src/capture.js';
import { configSchema, type RuntimeConfig } from '../src/config.js';
import { loadFingerprint, type Fingerprint } from '../src/fingerprint.js';

const secret = () => randomBytes(32).toString('base64url');
const messages = '{ "model": "test-model", "metadata": { "user_id": "remote-user-and-session" }, "messages": [{ "role": "user", "content": "private-prompt" }] }';

async function fixture(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void,
  overrides: Partial<RuntimeConfig> = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'cchop-capture-'));
  const upstream = createServer(handler);
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const port = (upstream.address() as AddressInfo).port;
  const config: RuntimeConfig = {
    ...configSchema.parse({}), configPath: join(folder, 'cchop.json'),
    gatewayToken: secret(), adminToken: secret(),
    fingerprintPath: join(folder, 'fingerprint.json'),
    claudeCredentialsPath: join(folder, 'credentials-do-not-exist.json'),
    upstream: `http://127.0.0.1:${port}`, shutdownGraceMs: 30,
    ...overrides,
  };
  const captures = new Set<RunningCapture>();
  t.after(async () => {
    await Promise.all([...captures].map((capture) => capture.close()));
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(folder, { recursive: true, force: true });
  });
  async function start(options: Parameters<typeof startCapture>[1] = {}) {
    const capture = await startCapture(config, { port: 0, ...options });
    captures.add(capture);
    return { capture, base: `http://127.0.0.1:${capture.port}` };
  }
  const auth = {
    authorization: `Bearer ${secret()}`, 'content-type': 'application/json',
    'user-agent': 'claude-cli/test (external, cli)',
  };
  return { config, start, auth };
}

function send(base: string, path: string, options: {
  method?: string;
  headers?: OutgoingHttpHeaders | readonly string[];
  body?: string;
} = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, {
      method: options.method ?? 'POST', headers: options.headers,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.once('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      res.once('error', reject);
    });
    req.once('error', reject);
    req.end(options.body);
  });
}

test('capture stores only remote identity while forwarding original OAuth, body bytes, and live SSE', { timeout: 10000 }, async (t) => {
  const event = 'event: content_block_delta\ndata: {"delta":{"text":"hello"}}\n\n';
  let incoming: IncomingMessage | undefined;
  let originalBody = '';
  let finish!: () => void;
  const f = await fixture(t, (req, res) => {
    incoming = req;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { originalBody += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(event);
      finish = () => res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
  });
  let selected: Fingerprint | undefined;
  const { capture, base } = await f.start({ onCaptured: (fingerprint) => { selected = fingerprint; } });
  let completed = false;
  void capture.completed.then(() => { completed = true; });
  const cookie = secret();
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = httpRequest(`${base}/v1/messages?beta=true`, {
      method: 'POST', signal: AbortSignal.timeout(5000),
      headers: {
        ...f.auth, 'x-api-key': secret(), cookie: `session=${cookie}`,
        'anthropic-beta': 'oauth-feature,future-feature', 'anthropic-version': '2023-06-01',
        'x-stainless-runtime': 'node', 'x-stainless-runtime-version': process.version,
        'x-future-identity': 'preserve-this', 'x-cchop-key': f.config.gatewayToken,
        'x-cchop-admin-key': f.config.adminToken, 'x-forwarded-for': '192.0.2.1',
        'x-real-ip': '192.0.2.2', connection: 'x-transport-only', 'x-transport-only': 'strip-this',
      },
    }, resolve);
    req.on('error', reject);
    req.end(messages);
  });
  const reader = response[Symbol.asyncIterator]();
  const first = await reader.next();
  assert.equal(new TextDecoder().decode(first.value), event);
  assert.equal(first.done, false);
  assert.equal(completed, false);
  assert.equal(capture.exchange, null);
  assert.equal(originalBody, messages);
  assert.equal(incoming?.url, '/v1/messages?beta=true');
  assert.equal(incoming?.headers.authorization, f.auth.authorization);
  assert.equal(incoming?.headers['user-agent'], f.auth['user-agent']);
  assert.equal(incoming?.headers['anthropic-beta'], 'oauth-feature,future-feature');
  assert.equal(incoming?.headers['x-future-identity'], 'preserve-this');
  for (const name of ['x-cchop-key', 'x-cchop-admin-key', 'x-forwarded-for', 'x-real-ip', 'x-transport-only']) {
    assert.equal(incoming?.headers[name], undefined);
  }
  const serialized = await readFile(f.config.fingerprintPath, 'utf8');
  const fingerprint = await loadFingerprint(f.config.fingerprintPath);
  assert.deepEqual(fingerprint, selected);
  assert.equal(fingerprint.metadataUserId, 'remote-user-and-session');
  assert.equal(fingerprint.nodeVersion, process.version);
  assert.equal(fingerprint.headers['x-stainless-runtime-version'], process.version);
  assert.equal(fingerprint.headers['anthropic-beta'], 'oauth-feature,future-feature');
  assert.equal(fingerprint.headers['x-future-identity'], 'preserve-this');
  assert.equal((await stat(f.config.fingerprintPath)).mode & 0o777, 0o600);
  for (const value of [f.auth.authorization, f.config.gatewayToken, f.config.adminToken, cookie, 'private-prompt']) {
    assert.equal(serialized.includes(value), false);
  }
  for (const name of ['authorization', 'x-api-key', 'cookie', 'content-length', 'host', 'connection', 'x-transport-only']) {
    assert.equal(fingerprint.headers[name], undefined);
  }
  finish();
  while (!(await reader.next()).done) { /* Drain the remaining unmodified stream. */ }
  await capture.completed;
  assert.deepEqual(capture.exchange, { upstreamStatus: 200, error: null });
});

test('capture preserves existing files unless replaced and rejects concurrent or repeated capture', { timeout: 10000 }, async (t) => {
  let calls = 0;
  let finish!: () => void;
  const f = await fixture(t, (_req, res) => {
    calls += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: ping\ndata: {}\n\n');
    finish = () => res.end();
  });
  await writeFile(f.config.fingerprintPath, 'existing file is preserved', { mode: 0o600 });
  await assert.rejects(f.start(), /already exists/);
  assert.equal(await readFile(f.config.fingerprintPath, 'utf8'), 'existing file is preserved');
  const { capture, base } = await f.start({ replace: true });
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: f.auth, body: messages, signal: AbortSignal.timeout(5000),
  });
  const reader = response.body!.getReader();
  await reader.read();
  const before = await readFile(f.config.fingerprintPath, 'utf8');
  const second = await send(base, '/v1/messages', {
    headers: f.auth, body: messages.replace('remote-user-and-session', 'second-identity'),
  });
  assert.equal(second.status, 409);
  assert.equal(await readFile(f.config.fingerprintPath, 'utf8'), before);
  finish();
  while (!(await reader.read()).done) { /* Drain to completion. */ }
  await capture.completed;
  assert.equal((await send(base, '/v1/messages', { headers: f.auth, body: messages })).status, 409);
  assert.equal(calls, 1);
});

test('capture rejects invalid identity, credentials, routes, methods, origins, and bodies before upstream access', { timeout: 10000 }, async (t) => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => { calls += 1; res.end('{}'); }, { maxRequestBytes: 1024, host: '0.0.0.0' });
  const { base, capture } = await f.start();
  const check = async (status: number, path: string, options: Parameters<typeof send>[2]) => {
    assert.equal((await send(base, path, options)).status, status);
  };
  await check(401, '/v1/messages', { body: messages });
  await check(401, '/v1/messages', { headers: { ...f.auth, authorization: `Bearer ${f.config.gatewayToken}` }, body: messages });
  await check(401, '/v1/messages', { headers: { ...f.auth, authorization: 'Bearer' }, body: messages });
  await check(400, '/v1/messages', { headers: ['Authorization', f.auth.authorization, 'Authorization', f.auth.authorization], body: messages });
  await check(404, '/other', { headers: f.auth, body: messages });
  await check(404, '/api/status', { method: 'GET', headers: f.auth });
  await check(405, '/v1/messages', { method: 'GET', headers: f.auth });
  await check(405, '/v1/models', { method: 'POST', headers: f.auth, body: messages });
  await check(403, '/v1/messages', { headers: { ...f.auth, host: `external.example:${capture.port}` }, body: messages });
  await check(403, '/v1/messages', { headers: { ...f.auth, origin: 'https://external.example' }, body: messages });
  await check(415, '/v1/messages', { headers: { ...f.auth, 'content-type': 'text/plain' }, body: messages });
  await check(415, '/v1/messages', { headers: { ...f.auth, 'content-encoding': 'gzip' }, body: messages });
  await check(413, '/v1/messages', { headers: f.auth, body: 'x'.repeat(1025) });
  await check(400, '/v1/messages', { headers: f.auth, body: '{malformed' });
  await check(400, '/v1/messages', { headers: f.auth, body: '{"metadata":{"user_id":""}}' });
  await check(400, '/v1/messages', { headers: f.auth, body: '{"messages":[]}' });
  await check(400, '/v1/messages', { headers: { authorization: f.auth.authorization, 'content-type': 'application/json' }, body: messages });
  assert.equal(calls, 0);
  assert.equal(capture.exchange, null);
  await assert.rejects(readFile(f.config.fingerprintPath), { code: 'ENOENT' });
  assert.equal((await send(base, '/v1/messages', { headers: f.auth, body: messages })).status, 200);
  await capture.completed;
  assert.equal(calls, 1);
});

test('warmup, model listing, and token counting do not consume the messages capture', { timeout: 10000 }, async (t) => {
  const paths: string[] = [];
  const bodies: string[] = [];
  const f = await fixture(t, (req, res) => {
    paths.push(req.url!);
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => { bodies.push(body); res.end('{}'); });
  });
  const { capture, base } = await f.start();
  assert.equal((await send(base, '/api/hello', { method: 'HEAD' })).status, 204);
  assert.equal((await send(base, '/v1/models', { method: 'GET', headers: f.auth })).status, 200);
  assert.equal((await send(base, '/v1/messages/count_tokens?beta=true', {
    headers: f.auth, body: '{"messages":[],"future_field":true}',
  })).status, 200);
  await assert.rejects(readFile(f.config.fingerprintPath), { code: 'ENOENT' });
  assert.equal(capture.exchange, null);
  assert.deepEqual(paths, ['/v1/models', '/v1/messages/count_tokens?beta=true']);
  assert.deepEqual(bodies, ['', '{"messages":[],"future_field":true}']);
  assert.equal((await send(base, '/v1/messages', { headers: f.auth, body: messages })).status, 200);
  await capture.completed;
  assert.equal((await loadFingerprint(f.config.fingerprintPath)).metadataUserId, 'remote-user-and-session');
});

test('capture retains valid fingerprints on provider errors and never follows redirects or retries', { timeout: 10000 }, async (t) => {
  for (const status of [429, 307]) {
    await t.test(`upstream HTTP ${status}`, async (subtest) => {
      let calls = 0;
      const f = await fixture(subtest, (_req, res) => {
        calls += 1;
        res.writeHead(status, {
          'content-type': 'application/json', 'retry-after': '30',
          ...(status === 307 ? { location: 'https://external.example/steal' } : {}),
        });
        res.end('{"error":{"type":"rate_limit_error"}}');
      });
      const { capture, base } = await f.start();
      const response = await send(base, '/v1/messages', { headers: f.auth, body: messages });
      await capture.completed;
      assert.equal(calls, 1);
      assert.equal(capture.exchange?.upstreamStatus, status);
      assert.equal((await loadFingerprint(f.config.fingerprintPath)).metadataUserId, 'remote-user-and-session');
      if (status === 429) {
        assert.equal(response.status, 429);
        assert.equal(response.headers['retry-after'], '30');
        assert.deepEqual(JSON.parse(response.body), { error: { type: 'rate_limit_error' } });
        assert.equal(capture.exchange?.error, null);
      } else {
        assert.equal(response.status, 502);
        assert.equal(response.headers.location, undefined);
        assert.match(capture.exchange?.error ?? '', /redirects are not accepted/);
      }
    });
  }
});

test('capture close aborts active streams, closes partial requests, and can cancel before capture', { timeout: 10000 }, async (t) => {
  let upstreamClosed!: () => void;
  const closed = new Promise<void>((resolve) => { upstreamClosed = resolve; });
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: ping\ndata: {}\n\n');
    res.once('close', upstreamClosed);
  });
  const { capture, base } = await f.start();
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: f.auth, body: messages, signal: AbortSignal.timeout(5000),
  });
  const reader = response.body!.getReader();
  await reader.read();
  const partial = httpRequest(`${base}/v1/messages/count_tokens`, {
    method: 'POST', headers: { ...f.auth, 'content-length': '100' },
  });
  partial.on('error', () => undefined);
  partial.write('{');
  const started = performance.now();
  await capture.close();
  await capture.completed;
  await closed;
  assert.ok(performance.now() - started < 2000);
  assert.equal(capture.exchange?.upstreamStatus, 200);
  assert.match(capture.exchange?.error ?? '', /interrupted|cancelled/);
  await reader.cancel().catch(() => undefined);
  partial.destroy();
  await capture.close();
  const second = await f.start({ replace: true });
  await second.capture.close();
  await second.capture.completed;
  assert.equal(second.capture.exchange, null);
});
