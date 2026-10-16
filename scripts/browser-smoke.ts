import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { configSchema, type RuntimeConfig } from '../src/config.js';
import { saveFingerprint } from '../src/fingerprint.js';
import { startApplication, type RunningApplication } from '../src/server.js';

// Exercise the built UI and real administration server with a loopback-only
// provider. All metrics come from requests made by this check; no provider
// credentials or production services are used.
const directory = await mkdtemp(join(tmpdir(), 'cchop-browser-'));
const upstream = createServer(async (req, res) => {
  for await (const chunk of req) void chunk;
  if (req.url?.includes('cancel')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
  } else if (req.url?.includes('error')) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Local test upstream unavailable.' } }));
  } else {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'local-smoke-response', content: [] }));
  }
});

let app: RunningApplication | undefined;
let browser: Browser | undefined;

try {
  await new Promise<void>((resolve) => { upstream.listen(0, '127.0.0.1', resolve); });
  const config: RuntimeConfig = {
    ...configSchema.parse({ upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, shutdownGraceMs: 500 }),
    port: 0,
    adminPort: 0,
    configPath: join(directory, 'cchop.json'),
    fingerprintPath: join(directory, 'fingerprint.json'),
    claudeCredentialsPath: join(directory, 'mock-claude-credentials.json'),
    gatewayToken: randomBytes(32).toString('base64url'),
    adminToken: randomBytes(32).toString('base64url'),
  };
  await saveFingerprint(config.fingerprintPath, {
    schemaVersion: 2,
    capturedAt: new Date().toISOString(), nodeVersion: process.version,
    headers: { 'user-agent': 'claude-cli/browser-smoke', 'anthropic-beta': 'oauth-test', 'x-stainless-runtime': 'node', 'x-stainless-runtime-version': process.version },
    identity: { device_id: 'browser-smoke-device', account_uuid: 'browser-smoke-account' },
  });
  await writeFile(config.claudeCredentialsPath, JSON.stringify({ claudeAiOauth: {
    accessToken: randomBytes(32).toString('base64url'), refreshToken: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 3600000,
  } }), { mode: 0o600 });
  app = await startApplication(config);
  const running = app;
  const headers = {
    Authorization: `Bearer ${config.gatewayToken}`,
    'Content-Type': 'application/json',
  };
  for (const scenario of ['success', 'error']) {
    const response = await fetch(`http://127.0.0.1:${app.relayPort}/v1/messages?scenario=${scenario}`, {
      method: 'POST', headers, body: JSON.stringify({ messages: [] }),
    });
    await response.text();
  }
  const cancellation = new AbortController();
  const stream = await fetch(`http://127.0.0.1:${app.relayPort}/v1/messages?scenario=cancel`, {
    method: 'POST', headers, body: JSON.stringify({ stream: true, messages: [] }), signal: cancellation.signal,
  });
  const reader = stream.body!.getReader();
  await reader.read();
  cancellation.abort();
  await reader.cancel().catch(() => undefined);
  await expect.poll(() => running.metrics.totals.requests).toBe(3);
  assert.equal(running.metrics.totals.succeeded, 1);
  assert.equal(running.metrics.totals.failed, 1);
  assert.equal(running.metrics.totals.cancelled, 1);

  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  const unexpectedErrors: string[] = [];
  let statusRequests = 0;
  page.on('pageerror', (error) => { unexpectedErrors.push(error.message); });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // Browser network diagnostics are expected for rejected credentials and
    // the deliberate offline check. Application and CSP errors are not.
    if (/Failed to load resource:.*(?:\b401\b|ERR_CONNECTION_REFUSED)/.test(message.text())) return;
    unexpectedErrors.push(message.text());
  });
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/status') statusRequests += 1;
  });
  await page.goto(`http://127.0.0.1:${app.adminPort}/`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Open your dashboard' })).toBeVisible();
  assert.equal(statusRequests, 0, 'The sign-in screen must not make unauthenticated status requests.');
  await page.screenshot({ path: join(tmpdir(), 'cchop-signin.png'), fullPage: true });

  await page.getByLabel('Admin key', { exact: true }).fill('incorrect-test-key');
  await page.getByRole('button', { name: 'Connect to relay' }).click();
  await expect(page.getByRole('alert')).toContainText('admin key was rejected');
  await page.getByLabel('Admin key', { exact: true }).fill(config.adminToken);
  await page.getByRole('button', { name: 'Connect to relay' }).click();
  await expect(page.getByText('Relay ready', { exact: true })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(3);
  await expect(page.getByText('3 of 3 retained requests')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();

  await page.getByRole('button', { name: 'Pause updates' }).click();
  const pausedCount = statusRequests;
  await page.waitForTimeout(3_300);
  assert.equal(statusRequests, pausedCount, 'Paused updates must not issue periodic requests.');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  assert.equal(statusRequests, pausedCount + 1, 'Manual refresh must work while polling is paused.');
  await page.getByRole('button', { name: 'Resume updates' }).click();
  await expect.poll(() => statusRequests).toBeGreaterThan(pausedCount + 1);
  await expect(page.getByText('Relay ready', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Pause updates' }).click();

  await page.getByRole('button', { name: 'Errors', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody')).toContainText('Upstream error');
  await page.getByRole('button', { name: 'Cancelled', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody')).toContainText('499');
  await page.getByRole('button', { name: 'All requests', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(3);
  assert.equal(await page.locator('html').evaluate((root) => root.scrollWidth <= root.clientWidth), true, 'Desktop must not overflow.');
  await page.screenshot({ path: join(tmpdir(), 'cchop-dashboard.png'), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('list', { name: 'Recent completed requests' })).toBeVisible();
  assert.equal(await page.locator('html').evaluate((root) => root.scrollWidth <= root.clientWidth), true, 'Mobile must not overflow.');
  await page.screenshot({ path: join(tmpdir(), 'cchop-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1080 });
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0, 'Credentials must not be stored in browser storage.');
  assert.equal((await page.locator('body').innerText()).includes(config.adminToken), false, 'Credentials must not be displayed.');

  await page.route('**/api/status', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"unexpected":true}' }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('unsupported format');
  await expect(page.locator('tbody tr')).toHaveCount(3);
  await page.unroute('**/api/status');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);

  config.adminToken = randomBytes(32).toString('base64url');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Open your dashboard' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('admin key was rejected');
  await expect(page.getByLabel('Admin key', { exact: true })).toHaveValue('');
  await page.getByLabel('Admin key', { exact: true }).fill(config.adminToken);
  await page.getByRole('button', { name: 'Connect to relay' }).click();
  await expect(page.getByText('Relay ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Open your dashboard' })).toBeVisible();
  const signedOutCount = statusRequests;
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(statusRequests, signedOutCount, 'Reload must require a new key without unauthenticated polling.');

  await page.getByLabel('Admin key', { exact: true }).fill(config.adminToken);
  await page.getByRole('button', { name: 'Connect to relay' }).click();
  await expect(page.getByText('Relay ready', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Pause updates' }).click();
  await app.close();
  app = undefined;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Disconnected', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('last successful update');
  await expect(page.locator('tbody tr')).toHaveCount(3);
  assert.deepEqual(unexpectedErrors, [], 'No unexpected browser, application, or CSP errors.');
  console.log('Browser smoke passed: real relay metrics, sign-in and key rotation, filters, pause/resume/refresh, malformed and offline states, logout, storage, desktop/mobile layout, and CSP.');
  console.log(`Screenshots: ${join(tmpdir(), 'cchop-signin.png')}, ${join(tmpdir(), 'cchop-dashboard.png')}, ${join(tmpdir(), 'cchop-mobile.png')}`);
} finally {
  await browser?.close();
  await app?.close();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => { upstream.close(() => { resolve(); }); });
  await rm(directory, { recursive: true, force: true });
}
