import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv, promisify } from 'node:util';

const execute = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'cchop-package-'));
const prefix = join(directory, 'install');
const configPath = join(directory, 'config', 'cchop.json');
const claudeCredentialsPath = join(directory, 'mock-claude-credentials.json');
const remoteOauth = { accessToken: randomBytes(32).toString('base64url'), refreshToken: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 3600000 };
const remoteSessionId = 'package-smoke-session';
const remoteIdentity = { device_id: 'package-smoke-device', account_uuid: 'package-smoke-account' };
const remoteUserId = JSON.stringify({ ...remoteIdentity, session_id: remoteSessionId });
const localIdentity = { device_id: 'local-device', account_uuid: 'local-account', session_id: 'local-session', future_field: { preserved: true } };
const remoteUserAgent = 'claude-cli/package-smoke';
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CCHOP_') && !key.startsWith('ANTHROPIC_')));
let child: ChildProcess | undefined;
let childExited: Promise<number | null> | undefined;
let captured = '';
let upstreamRequests = 0;
const receivedBodies: string[] = [];
const upstream = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
  receivedBodies.push(Buffer.concat(chunks).toString('utf8'));
  upstreamRequests += 1;
  assert.equal(req.headers['x-cchop-key'], undefined);
  assert.equal(req.headers.authorization, `Bearer ${remoteOauth.accessToken}`);
  assert.equal(req.headers['user-agent'], remoteUserAgent);
  assert.equal(req.headers['x-claude-code-session-id'], upstreamRequests === 1 ? remoteSessionId : localIdentity.session_id);
  if (upstreamRequests > 1) {
    assert.equal(req.headers['x-claude-code-agent-id'], 'local-agent');
    assert.equal(req.headers['x-claude-code-parent-agent-id'], 'local-parent');
    assert.equal(req.headers['x-claude-code-prompt-id'], 'local-prompt');
    assert.equal(req.headers['x-claude-code-request-class'], 'compaction');
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
});

async function availablePort(): Promise<number> {
  const listener = createTcpServer();
  await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
  const port = (listener.address() as AddressInfo).port;
  await new Promise<void>((done) => listener.close(() => done()));
  return port;
}

async function launch(binary: string, args: string[], readiness: string): Promise<void> {
  const outputStart = captured.length;
  child = spawn(binary, ['--config', configPath, ...args], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  childExited = new Promise((done) => child!.once('exit', done));
  await new Promise<void>((ready, reject) => {
    const timeout = setTimeout(() => reject(new Error('Installed cchop did not become ready.')), 10000);
    const onExit = () => { clearTimeout(timeout); reject(new Error(`Installed cchop exited before startup: ${captured.slice(outputStart)}`)); };
    child!.once('exit', onExit);
    child!.once('error', (error) => { clearTimeout(timeout); reject(error); });
    const onData = (chunk: Buffer) => {
      captured += chunk.toString();
      if (captured.slice(outputStart).includes(readiness)) { clearTimeout(timeout); child!.off('exit', onExit); ready(); }
    };
    child!.stdout!.on('data', onData);
    child!.stderr!.on('data', onData);
  });
}

async function expectSuccessfulExit(): Promise<void> {
  const exitCode = await Promise.race([
    childExited!,
    new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Installed cchop did not shut down.')), 5000); timer.unref(); }),
  ]);
  assert.equal(exitCode, 0);
}

try {
  const packed = await execute('npm', ['pack', '--ignore-scripts', '--json'], { env });
  const packages = JSON.parse(packed.stdout) as { filename: string; files: { path: string }[] }[];
  const artifact = packages[0]!;
  const paths = artifact.files.map((file) => file.path);
  assert.ok(paths.includes('dist/cli.js'));
  assert.ok(paths.includes('dist/capture.js'));
  assert.ok(paths.includes('dist/web/index.html'));
  assert.equal(paths.filter((path) => /^dist\/web\/assets\/.*\.js$/.test(path)).length, 1, 'Only the current UI bundle should be shipped.');
  for (const path of paths) assert.equal(/(^|\/)(\.argus|\.env|credentials\.env|\.credentials\.json|fingerprint\.json|claude\.settings\.json|node_modules|deploy|Dockerfile|\.dockerignore)(\/|$)/.test(path), false);
  const tarball = resolve(artifact.filename);
  await execute('npm', ['install', '--global', '--prefix', prefix, '--ignore-scripts', tarball], { cwd: directory, env, timeout: 120000 });
  const binary = process.platform === 'win32' ? join(prefix, 'cchop.cmd') : join(prefix, 'bin', 'cchop');
  const version = await execute(binary, ['--version'], { cwd: directory, env });
  assert.equal(version.stdout.trim(), '0.1.3');
  const relayPort = await availablePort();
  let adminPort = await availablePort();
  while (adminPort === relayPort) adminPort = await availablePort();
  const initialized = await execute(binary, ['--config', configPath, 'init', '--port', String(relayPort), '--admin-port', String(adminPort), '--credentials', claudeCredentialsPath], { cwd: directory, env });
  const credentials = parseEnv(await readFile(join(directory, 'config', 'credentials.env'), 'utf8'));
  const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  config.upstream = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(claudeCredentialsPath, JSON.stringify({ claudeAiOauth: remoteOauth }), { mode: 0o600 });
  const capturePort = await availablePort();
  await launch(binary, ['capture', '--port', String(capturePort)], 'Capture listening:');
  const captureBody = JSON.stringify({ messages: [{ role: 'user', content: 'capture-smoke-private-prompt' }], stream: true, metadata: { user_id: remoteUserId } });
  const captureResponse = await fetch(`http://127.0.0.1:${capturePort}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${remoteOauth.accessToken}`, 'content-type': 'application/json',
      'user-agent': remoteUserAgent, 'anthropic-beta': 'oauth-test',
      'x-claude-code-session-id': remoteSessionId, 'x-claude-code-prompt-id': 'capture-smoke-prompt', 'x-claude-code-request-class': 'main',
      'x-stainless-runtime': 'node', 'x-stainless-runtime-version': process.version,
    },
    body: captureBody,
  });
  assert.equal(captureResponse.status, 200);
  assert.match(await captureResponse.text(), /message_stop/);
  await expectSuccessfulExit();
  assert.equal(receivedBodies[0], captureBody, 'Capture must forward the real remote request unchanged.');
  const fingerprintText = await readFile(join(directory, 'config', 'fingerprint.json'), 'utf8');
  const fingerprint = JSON.parse(fingerprintText) as { schemaVersion: number; headers: Record<string, string>; identity: typeof remoteIdentity };
  assert.equal(fingerprint.schemaVersion, 2);
  assert.deepEqual(fingerprint.identity, remoteIdentity);
  assert.equal(fingerprint.headers['user-agent'], remoteUserAgent);
  assert.equal(fingerprint.headers['x-claude-code-session-id'], undefined);
  assert.equal(fingerprint.headers['x-claude-code-prompt-id'], undefined);
  assert.equal(fingerprint.headers['x-claude-code-request-class'], undefined);
  for (const value of [remoteOauth.accessToken, remoteOauth.refreshToken, remoteSessionId, 'capture-smoke-prompt', 'capture-smoke-private-prompt']) assert.equal(fingerprintText.includes(value), false);
  const clientSettingsPath = join(directory, 'client.settings.json');
  const client = await execute(binary, ['--config', configPath, 'client', '--url', `http://127.0.0.1:${relayPort}`, '--output', clientSettingsPath], { cwd: directory, env });
  const settings = JSON.parse(await readFile(clientSettingsPath, 'utf8')) as { env: Record<string, string> };
  assert.deepEqual(settings.env, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${relayPort}`, ANTHROPIC_AUTH_TOKEN: credentials.CCHOP_GATEWAY_TOKEN });
  const diagnosis = await execute(binary, ['--config', configPath, 'doctor', '--offline', '--json'], { cwd: directory, env });
  const checks = JSON.parse(diagnosis.stdout).checks as { status: string }[];
  assert.ok(checks.every((check) => check.status === 'ok'));
  await launch(binary, ['start', '--quiet'], 'Press Ctrl+C');
  const health = await fetch(`http://127.0.0.1:${relayPort}/healthz`);
  assert.equal(health.status, 200);
  const dashboard = await fetch(`http://127.0.0.1:${adminPort}/`);
  const html = await dashboard.text();
  assert.match(html, /cchop/i);
  const script = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(script, 'Bundled dashboard must reference a production script.');
  assert.equal((await fetch(`http://127.0.0.1:${adminPort}${script}`)).status, 200);
  const response = await fetch(`http://127.0.0.1:${relayPort}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${settings.env.ANTHROPIC_AUTH_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'local-client-smoke',
      'x-claude-code-session-id': 'local-session', 'x-claude-code-agent-id': 'local-agent',
      'x-claude-code-parent-agent-id': 'local-parent', 'x-claude-code-prompt-id': 'local-prompt',
      'x-claude-code-request-class': 'compaction',
    },
    body: JSON.stringify({ messages: [], stream: true, metadata: { user_id: JSON.stringify(localIdentity), extra: true } }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /message_stop/);
  assert.equal(upstreamRequests, 2);
  assert.deepEqual(JSON.parse(receivedBodies[1]!), { messages: [], stream: true, metadata: { user_id: JSON.stringify({ ...localIdentity, ...remoteIdentity }), extra: true } });
  const status = await fetch(`http://127.0.0.1:${adminPort}/api/status`, { headers: { 'x-cchop-admin-key': credentials.CCHOP_ADMIN_TOKEN! } });
  assert.equal(status.status, 200);
  const snapshot = await status.json() as { totals: { requests: number } };
  assert.equal(snapshot.totals.requests, 1);
  for (const token of [remoteOauth.accessToken, remoteOauth.refreshToken, ...Object.values(credentials)]) {
    if (token) assert.equal(`${captured}${initialized.stdout}${diagnosis.stdout}${client.stdout}`.includes(token), false);
  }
  child!.kill('SIGTERM');
  await expectSuccessfulExit();
  process.stdout.write('Packed global install passed: entry point, init, real capture command, doctor, client settings, bundled UI, subscription identity rewrite, streaming, and SIGTERM shutdown.\n');
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await childExited;
  }
  if (upstream.listening) {
    upstream.closeAllConnections();
    await new Promise<void>((done) => upstream.close(() => done()));
  }
  await rm(directory, { recursive: true, force: true });
}
