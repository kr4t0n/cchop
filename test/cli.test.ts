import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify, parseEnv } from 'node:util';
import { configSchema, loadConfiguration } from '../src/config.js';
import { saveFingerprint } from '../src/fingerprint.js';

const exec = promisify(execFile);
const cli = resolve('dist/cli.js');
const isolatedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CCHOP_') && !key.startsWith('ANTHROPIC_')));

test('init, doctor, and client work from another directory and never print generated secrets', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cchop-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'config', 'cchop.json');
  const claudeCredentialsPath = join(directory, 'mock-claude-credentials.json');
  const run = (...args: string[]) => exec(process.execPath, [cli, '--config', configPath, ...args], { cwd: directory, env: isolatedEnv });
  const initialized = await run('init', '--credentials', claudeCredentialsPath, '--fingerprint', 'recorded-fingerprint.json');
  const secrets = parseEnv(await readFile(join(directory, 'config', 'credentials.env'), 'utf8'));
  assert.ok(secrets.CCHOP_GATEWAY_TOKEN);
  assert.ok(secrets.CCHOP_ADMIN_TOKEN);
  assert.notEqual(secrets.CCHOP_GATEWAY_TOKEN, secrets.CCHOP_ADMIN_TOKEN);
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'config', 'credentials.env'))).mode & 0o777, 0o600);
  for (const value of Object.values(secrets)) if (value) assert.equal(initialized.stdout.includes(value), false);
  let missingDiagnostics = '';
  await assert.rejects(run('doctor', '--offline', '--json'), (error: unknown) => {
    assert.ok(error instanceof Error && 'stdout' in error && typeof error.stdout === 'string');
    missingDiagnostics = error.stdout;
    const checks = JSON.parse(error.stdout).checks as { name: string; status: string }[];
    assert.ok(checks.some((check) => /fingerprint/i.test(check.name) && check.status === 'error'));
    assert.ok(checks.some((check) => /credential|oauth|subscription/i.test(check.name) && check.status === 'error'));
    return true;
  });
  await assert.rejects(run('start'), /fingerprint/i);
  const loaded = await loadConfiguration(configPath, isolatedEnv);
  assert.equal(loaded.authMode, 'subscription');
  assert.equal(loaded.fingerprintPath, join(directory, 'config', 'recorded-fingerprint.json'));
  assert.equal(loaded.claudeCredentialsPath, claudeCredentialsPath);
  const oauth = { accessToken: randomBytes(32).toString('base64url'), refreshToken: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 3600000 };
  await writeFile(claudeCredentialsPath, JSON.stringify({ claudeAiOauth: oauth }), { mode: 0o600 });
  await saveFingerprint(loaded.fingerprintPath, {
    capturedAt: new Date().toISOString(), nodeVersion: process.version,
    headers: { 'user-agent': 'claude-cli/test', 'anthropic-beta': 'oauth-test', 'x-stainless-runtime': 'node', 'x-stainless-runtime-version': process.version },
    metadataUserId: 'remote-cli-test-identity',
  });
  const diagnostic = await run('doctor', '--offline', '--json');
  const checks = JSON.parse(diagnostic.stdout).checks as { status: string }[];
  assert.ok(checks.every((check) => check.status === 'ok'));
  const remoteFingerprint = JSON.parse(await readFile(loaded.fingerprintPath, 'utf8'));
  await saveFingerprint(loaded.fingerprintPath, { ...remoteFingerprint, nodeVersion: 'v0.0.0' }, { replace: true });
  const mismatch = JSON.parse((await run('doctor', '--offline', '--json')).stdout).checks as { name: string; status: string }[];
  assert.ok(mismatch.some((check) => check.name === 'capture runtime' && check.status === 'warn'));
  const output = join(directory, 'client.json');
  const generated = await run('client', '--url', 'https://cchop.example.com', '--output', output);
  const client = JSON.parse(await readFile(output, 'utf8')) as { env: Record<string, string> };
  assert.equal(client.env.ANTHROPIC_BASE_URL, 'https://cchop.example.com');
  assert.deepEqual(client.env, { ANTHROPIC_BASE_URL: 'https://cchop.example.com', ANTHROPIC_AUTH_TOKEN: secrets.CCHOP_GATEWAY_TOKEN });
  assert.equal(generated.stdout.includes(secrets.CCHOP_GATEWAY_TOKEN!), false);
  if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
  for (const value of [oauth.accessToken, oauth.refreshToken, ...Object.values(secrets).filter((value): value is string => !!value)]) {
    assert.equal(`${initialized.stdout}${missingDiagnostics}${diagnostic.stdout}${generated.stdout}`.includes(value), false);
  }
  await assert.rejects(run('init'), /already exists/);
  await assert.rejects(run('client', '--output', output), /already exists/);
  assert.equal(parseEnv(await readFile(join(directory, 'config', 'credentials.env'), 'utf8')).CCHOP_GATEWAY_TOKEN, secrets.CCHOP_GATEWAY_TOKEN);
});

test('environment overrides supply secrets and invalid inputs fail closed', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cchop-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'cchop.json');
  await writeFile(path, JSON.stringify(configSchema.parse({})));
  const gateway = randomBytes(32).toString('base64url');
  const admin = randomBytes(32).toString('base64url');
  const env = { CCHOP_GATEWAY_TOKEN: gateway, CCHOP_ADMIN_TOKEN: admin, CCHOP_HOST: '0.0.0.0', CCHOP_PORT: '9876' };
  const loaded = await loadConfiguration(path, env);
  assert.equal(loaded.host, '0.0.0.0');
  assert.equal(loaded.port, 9876);
  assert.equal(loaded.authMode, 'subscription');
  assert.equal(loaded.fingerprintPath, join(directory, 'fingerprint.json'));
  await assert.rejects(loadConfiguration(path, { ...env, CCHOP_GATEWAY_TOKEN: 'short' }), /CCHOP_GATEWAY_TOKEN/);
  await assert.rejects(loadConfiguration(path, { ...env, CCHOP_PORT: 'not-a-port' }), /port/);
  await assert.rejects(loadConfiguration(path, { ...env, CCHOP_UPSTREAM: 'http://example.com' }), /HTTPS origin/);
  await assert.rejects(loadConfiguration(path, { ...env, CCHOP_UPSTREAM: 'https://name:private@example.com' }), /HTTPS origin/);
  for (const legacyMode of ['passthrough', 'api-key']) {
    await assert.rejects(loadConfiguration(path, { ...env, CCHOP_AUTH_MODE: legacyMode }), /subscription|legacy|migrat/i);
  }
  await assert.rejects(loadConfiguration(path, { ...env, CCHOP_OAUTH_TOKEN_URL: 'http://example.com/token' }), /HTTPS/);
  await assert.rejects(loadConfiguration(path, { ...env, CCHOP_ADMIN_TOKEN: gateway }), /must be different/);
});
