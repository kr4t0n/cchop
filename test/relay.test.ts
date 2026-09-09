import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { configSchema, type RuntimeConfig } from '../src/config.js';
import { saveFingerprint } from '../src/fingerprint.js';
import { startApplication, type RunningApplication } from '../src/server.js';
import type { RequestRecord, StatusSnapshot } from '../src/types.js';

const secret = () => randomBytes(32).toString('base64url');
const capturedIdentity = {
  capturedAt: new Date().toISOString(),
  nodeVersion: process.version,
  headers: {
    'user-agent': 'claude-cli/0.0.0-test (external, cli)',
    'x-app': 'cli',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-test,remote-capability',
    'sec-fetch-mode': 'cors',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': process.version,
    'x-stainless-package-version': '0.0.0-test',
  },
  metadataUserId: 'captured-remote-user-and-session',
};

async function fixture(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void, overrides: Partial<RuntimeConfig> = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'cchop-relay-'));
  const resources: { app?: RunningApplication } = {};
  const upstream = createServer(handler);
  t.after(async () => {
    await resources.app?.close();
    upstream.closeAllConnections();
    if (upstream.listening) await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(folder, { recursive: true, force: true });
  });
  await writeFile(join(folder, 'index.html'), '<!doctype html><title>cchop</title>');
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const port = (upstream.address() as AddressInfo).port;
  const config: RuntimeConfig = {
    ...configSchema.parse({}), configPath: join(folder, 'cchop.json'),
    gatewayToken: secret(), adminToken: secret(),
    fingerprintPath: join(folder, 'fingerprint.json'),
    claudeCredentialsPath: join(folder, 'claude-credentials.json'),
    oauthTokenUrl: `http://127.0.0.1:${port}/oauth/token`,
    upstream: `http://127.0.0.1:${port}`, port: 0, adminPort: 0, shutdownGraceMs: 100,
    ...overrides,
  };
  const oauth = { accessToken: secret(), refreshToken: secret(), expiresAt: Date.now() + 3600000, scopes: ['user:inference'] };
  await saveFingerprint(config.fingerprintPath, capturedIdentity);
  await writeFile(config.claudeCredentialsPath, JSON.stringify({ claudeAiOauth: oauth, unrelated: { preserved: true } }), { mode: 0o600 });
  const logs: RequestRecord[] = [];
  const events: Record<string, string>[] = [];
  const app = await startApplication(config, { webDir: folder, log: (record) => logs.push(record), event: (record) => events.push(record) });
  resources.app = app;
  const base = `http://127.0.0.1:${app.relayPort}`;
  const admin = `http://127.0.0.1:${app.adminPort}`;
  const auth = { authorization: `Bearer ${config.gatewayToken}`, 'content-type': 'application/json' };
  return { config, app, base, admin, auth, logs, events, oauth };
}

test('relay rejects unauthenticated, unsupported, duplicate, and oversized requests before upstream access', async (t) => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => { calls += 1; res.end('{}'); }, { maxRequestBytes: 1024 });
  assert.equal((await fetch(`${f.base}/v1/messages`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${f.base}/v1/messages`, { method: 'POST', headers: { 'x-cchop-key': f.config.gatewayToken }, body: '{}' })).status, 401);
  assert.equal((await fetch(`${f.base}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${f.oauth.accessToken}` }, body: '{}' })).status, 401);
  assert.equal((await fetch(`${f.base}/v1/messages`, { headers: f.auth })).status, 405);
  assert.equal((await fetch(`${f.base}/unknown?token=private`, { headers: f.auth })).status, 404);
  assert.equal((await fetch(`${f.base}/v1/messages`, { method: 'POST', headers: f.auth, body: 'a'.repeat(1025) })).status, 413);
  assert.equal((await fetch(`${f.base}/api/status`, { headers: f.auth })).status, 404);
  const duplicateStatus = await new Promise<number>((resolveStatus, reject) => {
    const req = httpRequest(`${f.base}/v1/messages`, {
      method: 'POST', headers: ['Authorization', f.auth.authorization, 'Authorization', f.auth.authorization],
    }, (res) => { res.resume(); resolveStatus(res.statusCode!); });
    req.on('error', reject);
    req.end('{}');
  });
  assert.equal(duplicateStatus, 400);
  assert.equal(calls, 0);
});

test('replaces client identity and bearer authorization with the captured remote identity and subscription', async (t) => {
  const body = JSON.stringify({ metadata: { user_id: 'original-session', future_metadata: { preserved: true } }, messages: [{ role: 'user', content: 'private prompt' }], future_field: [1, 2] });
  let receivedBody = '';
  let incoming: IncomingMessage | undefined;
  const f = await fixture(t, (req, res) => {
    incoming = req;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { receivedBody += chunk; });
    req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
  });
  const result = await new Promise<{ status: number; body: string }>((resolveResult, reject) => {
    const req = httpRequest(`${f.base}/v1/messages?beta=true&next=enabled`, {
      method: 'POST',
      headers: { ...f.auth, 'anthropic-beta': 'future-capability,oauth-capability', 'anthropic-version': '2023-06-01',
        'user-agent': 'local-client-runtime', 'x-app': 'local-app', 'sec-fetch-mode': 'same-origin',
        'x-stainless-runtime': 'original-runtime', 'x-forwarded-for': '192.0.2.1', 'x-cchop-admin-key': f.config.adminToken,
        'x-stainless-local-only': 'local-platform', 'x-api-key': secret(), 'x-cchop-key': secret(),
        'x-client-trace': 'compatible-application-header',
        connection: 'x-remove-this', 'x-remove-this': 'transport-only' },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => resolveResult({ status: res.statusCode!, body: data }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), { ok: true });
  assert.deepEqual(JSON.parse(receivedBody), {
    ...JSON.parse(body),
    metadata: { user_id: capturedIdentity.metadataUserId, future_metadata: { preserved: true } },
  });
  assert.equal(Number(incoming?.headers['content-length']), Buffer.byteLength(receivedBody));
  assert.equal(incoming?.url, '/v1/messages?beta=true&next=enabled');
  assert.equal(incoming?.headers.authorization, `Bearer ${f.oauth.accessToken}`);
  for (const [name, value] of Object.entries(capturedIdentity.headers)) assert.equal(incoming?.headers[name], value);
  assert.equal(incoming?.headers['x-client-trace'], 'compatible-application-header');
  for (const name of ['x-cchop-key', 'x-cchop-admin-key', 'x-api-key', 'x-forwarded-for', 'x-remove-this', 'x-stainless-local-only']) assert.equal(incoming?.headers[name], undefined);
  await nextTurn();
  const logs = JSON.stringify([f.logs, f.events]);
  for (const sensitive of [body, 'private prompt', 'original-session', capturedIdentity.metadataUserId, f.oauth.accessToken, f.oauth.refreshToken, f.config.gatewayToken, f.config.adminToken]) assert.equal(logs.includes(sensitive), false);
  assert.equal(f.logs[0]?.path, '/v1/messages');
});

test('SSE first event arrives while upstream remains open; client cancellation closes upstream', { timeout: 5000 }, async (t) => {
  let closeUpstream!: () => void;
  const closed = new Promise<void>((resolve) => { closeUpstream = resolve; });
  const event = 'event: ping\ndata: {"type":"ping"}\n\n';
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(event);
    res.once('close', closeUpstream);
  });
  const response = await fetch(`${f.base}/v1/messages`, { method: 'POST', headers: f.auth, body: '{}', signal: AbortSignal.timeout(3000) });
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), event);
  assert.equal(first.done, false);
  assert.equal(f.app.metrics.active, 1);
  await reader.cancel();
  await closed;
  await nextTurn();
  assert.equal(f.app.metrics.active, 0);
  assert.equal(f.logs[0]?.outcome, 'cancelled');
});

test('upstream status and rate-limit headers pass through without automatic retries', async (t) => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => {
    calls += 1;
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30', 'request-id': 'upstream-reference' });
    res.end('{"error":{"type":"rate_limit_error"}}');
  });
  const response = await fetch(`${f.base}/v1/messages`, { method: 'POST', headers: f.auth, body: '{}' });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '30');
  assert.equal(response.headers.get('request-id'), 'upstream-reference');
  await response.text();
  assert.equal(calls, 1);
  await nextTurn();
  assert.equal(f.logs[0]?.outcome, 'upstream_error');
});

test('only remote subscription credentials reach upstream and administration remains isolated', async (t) => {
  let incoming: IncomingMessage | undefined;
  const f = await fixture(t, (req, res) => { incoming = req; res.end('{}'); });
  const response = await fetch(`${f.base}/v1/messages`, { method: 'POST', headers: { ...f.auth, 'x-api-key': secret() }, body: '{}' });
  await response.text();
  assert.equal(incoming?.headers['x-api-key'], undefined);
  assert.equal(incoming?.headers.authorization, `Bearer ${f.oauth.accessToken}`);
  assert.equal((await fetch(`${f.admin}/api/status`)).status, 401);
  assert.equal((await fetch(`${f.admin}/api/status`, { headers: { 'x-cchop-admin-key': f.config.gatewayToken } })).status, 401);
  const status = await fetch(`${f.admin}/api/status`, { headers: { 'x-cchop-admin-key': f.config.adminToken } });
  const snapshot = await status.json() as StatusSnapshot;
  assert.equal(snapshot.relay.authMode, 'subscription');
  assert.equal(snapshot.totals.requests, 1);
  const serialized = JSON.stringify(snapshot);
  for (const value of [f.oauth.accessToken, f.oauth.refreshToken, capturedIdentity.metadataUserId, f.config.adminToken, f.config.gatewayToken]) assert.equal(serialized.includes(value), false);
  const page = await fetch(f.admin);
  assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.match(await page.text(), /cchop/);
});

test('concurrency is bounded and shutdown cancels streams at the deadline', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: ping\ndata: {}\n\n');
  }, { maxConcurrent: 1, shutdownGraceMs: 30 });
  const first = await fetch(`${f.base}/v1/messages`, { method: 'POST', headers: f.auth, body: '{}' });
  const reader = first.body!.getReader();
  await reader.read();
  const second = await fetch(`${f.base}/v1/messages`, { method: 'POST', headers: f.auth, body: '{}' });
  assert.equal(second.status, 429);
  assert.equal(second.headers.get('retry-after'), '1');
  const started = performance.now();
  await f.app.close();
  assert.ok(performance.now() - started < 2000);
  assert.equal(f.app.metrics.draining, true);
  await reader.cancel().catch(() => undefined);
});

test('unknown future JSON fields and token counting remain compatible', async (t) => {
  let route: string | undefined;
  let body = '';
  const f = await fixture(t, (req, res) => {
    route = req.url;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => res.end('{"input_tokens":4}'));
  });
  const response = await fetch(`${f.base}/v1/messages/count_tokens?beta=true`, {
    method: 'POST', headers: f.auth, body: '{"messages":[],"future_capability":{"enabled":true}}',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { input_tokens: 4 });
  assert.equal(route, '/v1/messages/count_tokens?beta=true');
  assert.deepEqual(JSON.parse(body), { messages: [], future_capability: { enabled: true } });
});

test('invalid JSON and compressed requests fail before OAuth refresh or inference', async (t) => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => { calls += 1; res.end('{}'); });
  await writeFile(f.config.claudeCredentialsPath, JSON.stringify({ claudeAiOauth: { ...f.oauth, expiresAt: 0 } }), { mode: 0o600 });
  for (const body of ['{broken', 'null', '[]', '{"metadata":[]}']) {
    const response = await fetch(`${f.base}/v1/messages`, { method: 'POST', headers: f.auth, body });
    assert.equal(response.status, 400, `Invalid JSON object must be rejected: ${body}`);
    await response.text();
  }
  const compressed = await fetch(`${f.base}/v1/messages`, {
    method: 'POST', headers: { ...f.auth, 'content-encoding': 'gzip' }, body: '{}',
  });
  assert.equal(compressed.status, 415);
  await compressed.text();
  assert.equal(calls, 0, 'Rejected input must never trigger upstream authentication or inference.');
});

test('subscription credentials are reloaded from disk for subsequent requests', async (t) => {
  const authorizations: (string | undefined)[] = [];
  const f = await fixture(t, (req, res) => { authorizations.push(req.headers.authorization); res.end('{}'); });
  const send = () => fetch(`${f.base}/v1/messages`, { method: 'POST', headers: f.auth, body: '{}' });
  await (await send()).text();
  const replacement = { ...f.oauth, accessToken: secret(), refreshToken: secret() };
  await writeFile(f.config.claudeCredentialsPath, JSON.stringify({ claudeAiOauth: replacement }), { mode: 0o600 });
  await (await send()).text();
  assert.deepEqual(authorizations, [`Bearer ${f.oauth.accessToken}`, `Bearer ${replacement.accessToken}`]);
});

test('expiring subscriptions refresh and persist before the rewritten request reaches inference', async (t) => {
  const refreshed = { accessToken: secret(), refreshToken: secret() };
  let refreshes = 0;
  let refreshBody = '';
  let authorization: string | undefined;
  const f = await fixture(t, (req, res) => {
    if (req.url === '/oauth/token') {
      refreshes += 1;
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => { refreshBody += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: refreshed.accessToken, refresh_token: refreshed.refreshToken, expires_in: 3600 }));
      });
    } else {
      authorization = req.headers.authorization;
      res.end('{}');
    }
  });
  await writeFile(f.config.claudeCredentialsPath, JSON.stringify({ claudeAiOauth: { ...f.oauth, expiresAt: Date.now() + 60000 }, unrelated: { preserved: true } }), { mode: 0o600 });
  const response = await fetch(`${f.base}/v1/messages`, { method: 'POST', headers: f.auth, body: '{}' });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(refreshes, 1);
  assert.deepEqual(JSON.parse(refreshBody), { grant_type: 'refresh_token', refresh_token: f.oauth.refreshToken, client_id: f.config.oauthClientId });
  assert.equal(authorization, `Bearer ${refreshed.accessToken}`);
  const stored = JSON.parse(await readFile(f.config.claudeCredentialsPath, 'utf8')) as { claudeAiOauth: typeof f.oauth; unrelated: unknown };
  assert.equal(stored.claudeAiOauth.accessToken, refreshed.accessToken);
  assert.equal(stored.claudeAiOauth.refreshToken, refreshed.refreshToken);
  assert.ok(stored.claudeAiOauth.expiresAt > Date.now() + 3000000);
  assert.deepEqual(stored.unrelated, { preserved: true });
  await nextTurn();
  const logs = JSON.stringify([f.logs, f.events]);
  for (const value of [f.oauth.accessToken, f.oauth.refreshToken, refreshed.accessToken, refreshed.refreshToken]) assert.equal(logs.includes(value), false);
});

test('failed OAuth refresh preserves credentials and blocks inference without leaking provider error details', async (t) => {
  let refreshes = 0;
  let inferences = 0;
  const providerDiagnostic = `private-provider-diagnostic-${secret()}`;
  const f = await fixture(t, (req, res) => {
    if (req.url === '/oauth/token') {
      refreshes += 1;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant', error_description: providerDiagnostic }));
    } else {
      inferences += 1;
      res.end('{}');
    }
  });
  const original = JSON.stringify({ claudeAiOauth: { ...f.oauth, expiresAt: Date.now() + 60000 }, unrelated: { preserved: true } });
  await writeFile(f.config.claudeCredentialsPath, original, { mode: 0o600 });
  const response = await fetch(`${f.base}/v1/messages`, { method: 'POST', headers: f.auth, body: '{}' });
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.equal(refreshes, 1);
  assert.equal(inferences, 0);
  assert.equal(await readFile(f.config.claudeCredentialsPath, 'utf8'), original);
  await nextTurn();
  for (const value of [providerDiagnostic, f.oauth.accessToken, f.oauth.refreshToken]) {
    assert.equal(`${body}${JSON.stringify([f.logs, f.events])}`.includes(value), false);
  }
});

test('redirects cannot send client gateway credentials to a different origin', async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(307, { location: 'https://other-origin.example/v1/messages' });
    res.end();
  });
  const response = await fetch(`${f.base}/v1/messages`, { method: 'POST', headers: f.auth, body: '{}' });
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('location'), null);
  assert.match(await response.text(), /redirects are not accepted/);
});

test('an upstream stream failure is recorded as a relay failure, not a client cancellation', { timeout: 5000 }, async (t) => {
  let breakStream!: () => void;
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: ping\ndata: {}\n\n');
    breakStream = () => res.destroy();
  });
  const response = await fetch(`${f.base}/v1/messages`, { method: 'POST', headers: f.auth, body: '{}' });
  const reader = response.body!.getReader();
  await reader.read();
  breakStream();
  await assert.rejects(reader.read());
  await nextTurn();
  assert.equal(f.logs[0]?.outcome, 'relay_error');
  assert.equal(f.logs[0]?.status, 502);
});
