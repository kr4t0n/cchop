import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const image = process.argv[2] ?? 'cchop:local';
const name = `cchop-smoke-${randomUUID()}`;
const volume = `${name}-home`;
const mount = `type=volume,source=${volume},target=/home/node`;
const isolation = ['--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'];
let child: ChildProcess | undefined;
let exited: Promise<number | null> | undefined;
let output = '';

async function docker(args: string[]): Promise<string> {
  return (await execute('docker', args, { timeout: 60000, maxBuffer: 1024 * 1024 })).stdout;
}

const run = (...args: string[]) => docker(['run', '--rm', ...isolation, '--name', name, '--network', 'none', '--mount', mount, image, ...args]);
const inside = (code: string) => docker(['exec', name, 'node', '--input-type=module', '--eval', code]);
const common = `
  import assert from 'node:assert/strict';
  import { readFile, writeFile, mkdir, stat, access } from 'node:fs/promises';
  import { createServer } from 'node:http';
  import { randomBytes } from 'node:crypto';
  import { parseEnv } from 'node:util';
  const directory = '/home/node/.config/cchop';
  const credentialsPath = '/home/node/.claude/.credentials.json';
  const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
  const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
`;

async function launch(args: string[], ready: string, input?: string): Promise<void> {
  output = '';
  child = spawn('docker', ['run', '--rm', ...isolation, ...(input ? ['--interactive'] : []), '--network', 'none', '--name', name, '--mount', mount, image, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  exited = new Promise((resolve, reject) => {
    child!.once('exit', resolve);
    child!.once('error', reject);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Container did not become ready: ${output}`)), 30000);
    const onExit = () => { clearTimeout(timer); reject(new Error(`Container exited before startup: ${output}`)); };
    child!.once('exit', onExit);
    child!.once('error', (error) => { clearTimeout(timer); reject(error); });
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(ready)) {
        clearTimeout(timer);
        child!.off('exit', onExit);
        resolve();
      }
    };
    child!.stdout!.on('data', onData);
    child!.stderr!.on('data', onData);
    if (input) child!.stdin!.write(input);
    else child!.stdin!.end();
  });
}

async function expectExit(): Promise<void> {
  const code = await Promise.race([
    exited!,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Container did not exit.')), 10000);
      timer.unref();
    }),
  ]);
  assert.equal(code, 0, output);
  child = undefined;
}

try {
  await docker(['volume', 'create', volume]);
  assert.match(await run('claude', '--version'), /^\d+\.\d+\.\d+ \(Claude Code\)/);
  assert.match(await run('cchop', '--version'), /^\d+\.\d+\.\d+/);
  await run('cchop', 'init');
  await run('node', '--input-type=module', '--eval', common + String.raw`
    assert.equal(process.getuid(), 1000);
    assert.equal(process.env.DISABLE_AUTOUPDATER, '1');
    assert.equal(process.env.DISABLE_UPDATES, '1');
    for (const path of ['/opt/cchop/node_modules/typescript', '/opt/cchop/node_modules/react', '/opt/cchop/src']) {
      await assert.rejects(access(path), { code: 'ENOENT' });
    }
    const configPath = directory + '/cchop.json';
    const config = await readJson(configPath);
    assert.equal(config.claudeCredentialsPath, credentialsPath);
    config.upstream = 'http://127.0.0.1:19090';
    config.oauthTokenUrl = 'http://127.0.0.1:19090/token';
    await writeFile(configPath, JSON.stringify(config));
    await mkdir('/home/node/.claude', { recursive: true, mode: 0o700 });
    await writeFile(credentialsPath, JSON.stringify({ claudeAiOauth: {
      accessToken: randomBytes(32).toString('hex'), refreshToken: randomBytes(32).toString('hex'), expiresAt: 0,
    } }), { mode: 0o600 });
  `);

  await launch(['bash'], 'Capture listening:', 'cchop capture\n');
  await inside(common + String.raw`
    const oauth = (await readJson(credentialsPath)).claudeAiOauth;
    const upstream = createServer((req, res) => {
      assert.equal(req.headers.authorization, 'Bearer ' + oauth.accessToken);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
    await new Promise((resolve) => upstream.listen(19090, '127.0.0.1', resolve));
    try {
      const response = await request('http://127.0.0.1:9999/v1/messages', {
        method: 'POST', headers: { authorization: 'Bearer ' + oauth.accessToken, 'content-type': 'application/json', 'user-agent': 'claude-cli/docker-smoke' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'synthetic capture' }], metadata: { user_id: JSON.stringify({ device_id: 'remote-device', account_uuid: 'remote-account', session_id: 'capture-session' }) } }),
      });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /message_stop/);
    } finally { upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); }
  `);
  child!.stdin!.end('exit "$?"\n');
  await expectExit();

  await launch([], 'Press Ctrl+C');
  assert.match(output, /bind 0\.0\.0\.0/);
  await inside(common + String.raw`
    const keys = parseEnv(await readFile(directory + '/credentials.env', 'utf8'));
    const previous = (await readJson(credentialsPath)).claudeAiOauth;
    const accessToken = randomBytes(32).toString('hex');
    let refreshes = 0, messages = 0;
    const upstream = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (req.url === '/token') {
        assert.equal(body.refresh_token, previous.refreshToken);
        refreshes++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: accessToken, expires_in: 3600, scope: 'user:inference' }));
      } else {
        assert.equal(req.headers.authorization, 'Bearer ' + accessToken);
        assert.equal(req.headers['x-claude-code-session-id'], 'client-session');
        assert.deepEqual(JSON.parse(body.metadata.user_id), { device_id: 'remote-device', account_uuid: 'remote-account', session_id: 'client-session' });
        messages++;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      }
    });
    await new Promise((resolve) => upstream.listen(19090, '127.0.0.1', resolve));
    try {
      assert.equal((await request('http://127.0.0.1:8787/healthz')).status, 200);
      const html = await (await request('http://127.0.0.1:8788/')).text();
      const script = html.match(/src="([^"]+\.js)"/)?.[1];
      assert.ok(script);
      const bundle = await request('http://127.0.0.1:8788' + script);
      assert.equal(bundle.status, 200);
      assert.match(bundle.headers.get('content-type'), /javascript/);
      const icon = await request('http://127.0.0.1:8788/favicon.svg');
      assert.equal(icon.status, 200);
      assert.match(icon.headers.get('content-type'), /image\/svg\+xml/);
      assert.equal((await request('http://127.0.0.1:8788/api/status')).status, 401);
      assert.equal((await request('http://127.0.0.1:8788/api/status', { headers: { 'x-cchop-admin-key': keys.CCHOP_ADMIN_TOKEN } })).status, 200);
      const response = await request('http://127.0.0.1:8787/v1/messages', {
        method: 'POST', headers: { authorization: 'Bearer ' + keys.CCHOP_GATEWAY_TOKEN, 'content-type': 'application/json', 'x-claude-code-session-id': 'client-session' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'synthetic relay' }], metadata: { user_id: JSON.stringify({ device_id: 'local-device', account_uuid: 'local-account', session_id: 'client-session' }) } }),
      });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /message_stop/);
      assert.equal(refreshes, 1);
      assert.equal(messages, 1);
      const stored = (await readJson(credentialsPath)).claudeAiOauth;
      assert.equal(stored.accessToken, accessToken);
      assert.equal(stored.refreshToken, previous.refreshToken);
      assert.deepEqual(stored.scopes, ['user:inference']);
      assert.equal((await stat(credentialsPath)).mode & 0o777, 0o600);
    } finally { upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); }
  `);
  await docker(['exec', name, 'cchop', 'doctor', '--offline']);
  await docker(['stop', '--timeout', '45', name]);
  await expectExit();
  assert.match(output, /cchop stopped/);
  await run('cchop', 'doctor', '--offline');
  process.stdout.write('Docker smoke passed: both CLIs, non-root volume persistence, capture, refresh, relay, dashboard, and graceful container shutdown.\n');
} finally {
  await docker(['rm', '--force', name]).catch(() => undefined);
  if (child) await exited;
  await docker(['volume', 'rm', volume]);
}
