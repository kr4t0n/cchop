import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { CredentialError, createCredentialProvider, readCredentials } from '../src/credentials.js';
import type { ClaudeCredentials, CredentialProviderOptions } from '../src/credentials.js';

const fakeToken = () => `test-${randomBytes(24).toString('base64url')}`;

function credentials(expiresAt = Date.now() - 1000): ClaudeCredentials {
  return {
    extraTopLevel: { preferences: ['keep', 'these'] },
    claudeAiOauth: {
      accessToken: fakeToken(),
      refreshToken: fakeToken(),
      expiresAt,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'test-subscription',
      extraNested: { untouched: true },
    },
  };
}

async function fixture(t: TestContext, initial = credentials()) {
  const directory = await mkdtemp(join(tmpdir(), 'cchop-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'credentials.json');
  await writeFile(path, JSON.stringify(initial), { mode: 0o600 });
  return { directory, path, initial };
}

async function mockOAuth(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}/oauth/token`;
}

function provider(t: TestContext, options: CredentialProviderOptions) {
  const result = createCredentialProvider(options);
  t.after(() => result.close());
  return result;
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(Buffer.from(part));
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
}

test('concurrent callers refresh once, persist rotated tokens and retain unknown metadata', async (t) => {
  const { path, initial } = await fixture(t);
  const accessToken = fakeToken();
  const refreshToken = fakeToken();
  let refreshes = 0;
  const events: unknown[] = [];
  const before = Date.now();
  const tokenUrl = await mockOAuth(t, async (request, response) => {
    refreshes += 1;
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.deepEqual(await requestBody(request), {
      grant_type: 'refresh_token',
      refresh_token: initial.claudeAiOauth.refreshToken,
      client_id: 'test-client',
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ access_token: accessToken, refresh_token: refreshToken, expires_in: 3600 }));
  });
  const current = provider(t, { path, tokenUrl, clientId: 'test-client', onEvent: (event) => events.push(event) });
  assert.deepEqual(await Promise.all(Array.from({ length: 40 }, () => current.getAccessToken())), Array(40).fill(accessToken));
  assert.equal(await current.getAccessToken(), accessToken);
  assert.equal(refreshes, 1);
  const saved = await readCredentials(path);
  assert.equal(saved.claudeAiOauth.accessToken, accessToken);
  assert.equal(saved.claudeAiOauth.refreshToken, refreshToken);
  assert.ok(saved.claudeAiOauth.expiresAt >= before + 3600000);
  assert.ok(saved.claudeAiOauth.expiresAt <= Date.now() + 3600000);
  assert.deepEqual(saved, {
    ...initial,
    claudeAiOauth: { ...initial.claudeAiOauth, accessToken, refreshToken, expiresAt: saved.claudeAiOauth.expiresAt },
  });
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(events, [{ event: 'oauth_refresh', status: 'ok' }]);
});

test('successive refreshes use the last persisted rotation and notice externally replaced credentials', async (t) => {
  const { path, initial } = await fixture(t);
  const rotations = [
    { access_token: fakeToken(), refresh_token: fakeToken(), expires_in: 3600 },
    { access_token: fakeToken(), refresh_token: fakeToken(), expires_in: 3600 },
  ];
  const seen: unknown[] = [];
  const tokenUrl = await mockOAuth(t, async (request, response) => {
    seen.push(await requestBody(request));
    response.end(JSON.stringify(rotations[seen.length - 1]));
  });
  const current = provider(t, { path, tokenUrl, clientId: 'test-client' });
  assert.equal(await current.getAccessToken(), rotations[0]!.access_token);
  const first = await readCredentials(path);
  first.claudeAiOauth.expiresAt = Date.now() - 1000;
  await writeFile(path, JSON.stringify(first));
  assert.equal(await current.getAccessToken(), rotations[1]!.access_token);
  assert.deepEqual(seen, [
    { grant_type: 'refresh_token', refresh_token: initial.claudeAiOauth.refreshToken, client_id: 'test-client' },
    { grant_type: 'refresh_token', refresh_token: rotations[0]!.refresh_token, client_id: 'test-client' },
  ]);
  const external = credentials(Date.now() + 7200000);
  await writeFile(`${path}.replacement`, JSON.stringify(external));
  await rename(`${path}.replacement`, path);
  assert.equal(await current.getAccessToken(), external.claudeAiOauth.accessToken);
  assert.equal(seen.length, 2);
});

test('valid credentials outside the refresh window require no OAuth request; near expiry refreshes', async (t) => {
  const { path } = await fixture(t, credentials(Date.now() + 7200000));
  let calls = 0;
  const next = fakeToken();
  const tokenUrl = await mockOAuth(t, (_request, response) => {
    calls += 1;
    response.end(JSON.stringify({ access_token: next, refresh_token: fakeToken(), expires_in: 3600 }));
  });
  const current = provider(t, { path, tokenUrl, clientId: 'test-client' });
  assert.equal(await current.getAccessToken(), (await readCredentials(path)).claudeAiOauth.accessToken);
  assert.equal(calls, 0);
  const nearExpiry = await readCredentials(path);
  nearExpiry.claudeAiOauth.expiresAt = Date.now() + 60000;
  await writeFile(path, JSON.stringify(nearExpiry));
  assert.equal(await current.getAccessToken(), next);
  assert.equal(calls, 1);
});

test('invalid credential files fail without leaking file contents', async (t) => {
  const { path } = await fixture(t);
  const secret = fakeToken();
  for (const value of [
    secret,
    JSON.stringify({ claudeAiOauth: { accessToken: secret, expiresAt: Date.now() } }),
    JSON.stringify({ claudeAiOauth: { accessToken: secret, refreshToken: secret, expiresAt: 'tomorrow' } }),
    JSON.stringify({ claudeAiOauth: { accessToken: `${secret}\n`, refreshToken: secret, expiresAt: Date.now() } }),
    JSON.stringify({ claudeAiOauth: { accessToken: secret, refreshToken: secret, expiresAt: -1 } }),
    'x'.repeat(1024 * 1024 + 1),
  ]) {
    await writeFile(path, value);
    await assert.rejects(readCredentials(path), (error: unknown) => {
      assert.ok(error instanceof CredentialError);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('malformed OAuth responses leave previous credentials untouched and report sanitized errors', async (t) => {
  const { path, directory, initial } = await fixture(t);
  const original = await readFile(path, 'utf8');
  const secret = fakeToken();
  const invalid = [
    secret,
    JSON.stringify({ access_token: secret, expires_in: 3600 }),
    JSON.stringify({ refresh_token: secret, expires_in: 3600 }),
    JSON.stringify({ access_token: secret, refresh_token: secret, expires_in: 0 }),
    JSON.stringify({ access_token: secret, refresh_token: secret, expires_in: '3600' }),
    JSON.stringify({ access_token: `${secret}\r\n`, refresh_token: secret, expires_in: 3600 }),
    JSON.stringify({ access_token: secret, refresh_token: secret, expires_in: 1e300 }),
  ];
  const events: unknown[] = [];
  let calls = 0;
  const tokenUrl = await mockOAuth(t, (_request, response) => { response.end(invalid[calls++]); });
  const current = provider(t, { path, tokenUrl, clientId: 'test-client', onEvent: (event) => events.push(event) });
  for (let index = 0; index < invalid.length; index += 1) {
    await assert.rejects(current.getAccessToken(), (error: unknown) => {
      assert.ok(error instanceof CredentialError);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes(initial.claudeAiOauth.refreshToken), false);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(await readFile(path, 'utf8'), original);
  }
  assert.equal(calls, invalid.length);
  assert.deepEqual(events, invalid.map(() => ({ event: 'oauth_refresh', status: 'error' })));
  assert.deepEqual(await readdir(directory), ['credentials.json']);
});

test('OAuth rejection, redirects, and oversized responses never replace credentials or follow Location', async (t) => {
  const { path } = await fixture(t);
  const original = await readFile(path, 'utf8');
  let redirectedCalls = 0;
  const redirectUrl = await mockOAuth(t, (_request, response) => {
    redirectedCalls += 1;
    response.end('{}');
  });
  const replies = [401, 503, 302, 200];
  let calls = 0;
  const tokenUrl = await mockOAuth(t, (_request, response) => {
    const status = replies[calls++];
    response.writeHead(status!, { location: redirectUrl });
    response.end(status === 200 ? 'x'.repeat(64 * 1024 + 1) : fakeToken());
  });
  const current = provider(t, { path, tokenUrl, clientId: 'test-client' });
  for (let index = 0; index < replies.length; index += 1) {
    await assert.rejects(current.getAccessToken(), CredentialError);
    assert.equal(await readFile(path, 'utf8'), original);
  }
  assert.equal(redirectedCalls, 0);
});

test('an external login during refresh is preserved and used by the following request', async (t) => {
  const { path, directory } = await fixture(t);
  const external = credentials(Date.now() + 7200000);
  let calls = 0;
  const tokenUrl = await mockOAuth(t, async (_request, response) => {
    calls += 1;
    await writeFile(`${path}.replacement`, JSON.stringify(external));
    await rename(`${path}.replacement`, path);
    response.end(JSON.stringify({ access_token: fakeToken(), refresh_token: fakeToken(), expires_in: 3600 }));
  });
  const current = provider(t, { path, tokenUrl, clientId: 'test-client' });
  await assert.rejects(current.getAccessToken(), /credentials changed during refresh/);
  assert.deepEqual(await readCredentials(path), external);
  assert.equal(await current.getAccessToken(), external.claudeAiOauth.accessToken);
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(directory), ['credentials.json']);
});

test('persistence failure returns no fresh token and preserves the prior file', {
  skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'Needs non-root POSIX directory permissions' : false,
}, async (t) => {
  const { path, directory } = await fixture(t);
  const original = await readFile(path, 'utf8');
  const accessToken = fakeToken();
  const events: unknown[] = [];
  const tokenUrl = await mockOAuth(t, (_request, response) => {
    response.end(JSON.stringify({ access_token: accessToken, refresh_token: fakeToken(), expires_in: 3600 }));
  });
  const current = provider(t, { path, tokenUrl, clientId: 'test-client', onEvent: (event) => events.push(event) });
  await chmod(directory, 0o500);
  try {
    await assert.rejects(current.getAccessToken(), (error: unknown) => {
      assert.ok(error instanceof CredentialError);
      assert.match(error.message, /Cannot persist refreshed/);
      assert.equal(error.message.includes(accessToken), false);
      return true;
    });
    assert.equal(await readFile(path, 'utf8'), original);
    assert.deepEqual(events, [{ event: 'oauth_refresh', status: 'error' }]);
    assert.deepEqual(await readdir(directory), ['credentials.json']);
  } finally {
    await chmod(directory, 0o700);
  }
});

test('total refresh timeout and provider close abort pending refreshes without persisting', async (t) => {
  const { path } = await fixture(t);
  const original = await readFile(path, 'utf8');
  const tokenUrl = await mockOAuth(t, () => undefined);
  const timed = provider(t, { path, tokenUrl, clientId: 'test-client', timeoutMs: 40 });
  await assert.rejects(timed.getAccessToken(), CredentialError);
  assert.equal(await readFile(path, 'utf8'), original);
  let arrivedAgain!: () => void;
  const arrival = new Promise<void>((resolve) => { arrivedAgain = resolve; });
  const otherUrl = await mockOAuth(t, () => arrivedAgain());
  const closing = provider(t, { path, tokenUrl: otherUrl, clientId: 'test-client', timeoutMs: 5000 });
  const pending = assert.rejects(closing.getAccessToken(), CredentialError);
  await arrival;
  await closing.close();
  await pending;
  await assert.rejects(closing.getAccessToken(), /provider is closed/);
  assert.equal(await readFile(path, 'utf8'), original);
});

test('close during credential persistence waits for both rotated tokens and reports the successful refresh', async (t) => {
  const { path, directory, initial } = await fixture(t);
  const accessToken = fakeToken();
  const refreshToken = fakeToken();
  const events: unknown[] = [];
  const tokenUrl = await mockOAuth(t, (_request, response) => {
    response.end(JSON.stringify({ access_token: accessToken, refresh_token: refreshToken, expires_in: 3600 }));
  });
  const current = provider(t, { path, tokenUrl, clientId: 'test-client', onEvent: (event) => events.push(event) });

  let notifyCommit!: () => void;
  let releaseCommit!: () => void;
  const commitEntered = new Promise<void>((resolve) => { notifyCommit = resolve; });
  const commitReleased = new Promise<void>((resolve) => { releaseCommit = resolve; });
  const probe = await open(path, 'r');
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const originalSync = probe.sync;
  await probe.close();
  // Intercept the actual temporary-file fsync, after the OAuth response has been
  // accepted, so shutdown deterministically lands before the atomic rename.
  const sync = t.mock.method(prototype, 'sync', async function (this: FileHandle) {
    await originalSync.call(this);
    notifyCommit();
    await commitReleased;
  });
  const pending = assert.rejects(current.getAccessToken(), /provider is closed/);
  let closing: Promise<void> | undefined;
  let closed = false;
  try {
    await commitEntered;
    closing = current.close().then(() => { closed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false, 'Shutdown must wait for the credential commit.');
    assert.equal(sync.mock.callCount(), 1);
    assert.deepEqual(await readCredentials(path), initial, 'The original file remains intact before rename.');
  } finally {
    releaseCommit();
    await Promise.all([pending, closing]);
  }
  assert.equal(closed, true);
  const saved = await readCredentials(path);
  assert.equal(saved.claudeAiOauth.accessToken, accessToken);
  assert.equal(saved.claudeAiOauth.refreshToken, refreshToken);
  assert.deepEqual(saved.extraTopLevel, initial.extraTopLevel);
  assert.deepEqual(events, [{ event: 'oauth_refresh', status: 'ok' }]);
  assert.deepEqual(await readdir(directory), ['credentials.json']);
  await assert.rejects(current.getAccessToken(), /provider is closed/);
});

test('token endpoint validation rejects remote plaintext and URL secrets before any request', () => {
  for (const tokenUrl of [
    'http://example.com/oauth/token',
    'https://user:password@example.com/oauth/token',
    'https://example.com/oauth/token?secret=value',
    'https://example.com/oauth/token#secret',
    'not-a-url',
  ]) {
    assert.throws(() => createCredentialProvider({ path: 'unused', tokenUrl, clientId: 'test-client' }), CredentialError);
  }
});
