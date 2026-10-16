import { access } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { connect } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { localUrl, type RuntimeConfig } from './config.js';
import { readCredentials, CredentialError } from './credentials.js';
import { FingerprintError, loadFingerprint, runtimeWarning } from './fingerprint.js';

interface Check { name: string; status: 'ok' | 'warn' | 'error'; message: string }

export async function runDoctor(config: RuntimeConfig, offline: boolean): Promise<Check[]> {
  const checks: Check[] = [
    { name: 'configuration', status: 'ok', message: config.configPath },
    { name: 'credentials', status: 'ok', message: `Relay and administration keys loaded; ${config.authMode} mode.` },
    { name: 'runtime', status: 'ok', message: `Node ${process.version}` },
  ];
  try {
    await access(fileURLToPath(new URL('../dist/web/index.html', import.meta.url)));
    checks.push({ name: 'dashboard', status: 'ok', message: 'Bundled dashboard is available.' });
  } catch {
    checks.push({ name: 'dashboard', status: 'error', message: 'Dashboard missing. Build the source checkout or reinstall cchop.' });
  }
  try {
    const fingerprint = await loadFingerprint(config.fingerprintPath);
    checks.push({ name: 'fingerprint', status: 'ok', message: `Captured ${fingerprint.capturedAt}.` });
    const warning = runtimeWarning(fingerprint);
    checks.push({ name: 'capture runtime', status: warning ? 'warn' : 'ok', message: warning ?? 'Capture and relay Node major versions match; this does not verify TLS fingerprint equivalence.' });
  } catch (error) {
    checks.push({ name: 'fingerprint', status: 'error', message: error instanceof FingerprintError
      ? error.message : 'A valid remote fingerprint is required. Run cchop capture on the relay host.' });
  }
  try {
    const credentials = await readCredentials(config.claudeCredentialsPath);
    const expiring = credentials.claudeAiOauth.expiresAt - Date.now() <= 5 * 60 * 1000;
    checks.push({ name: 'remote OAuth credentials', status: expiring ? 'warn' : 'ok', message: expiring
      ? 'Credentials require refresh before the next request. Doctor never refreshes tokens.'
      : 'Remote access and refresh credentials loaded. Token values are not displayed.' });
  } catch (error) {
    checks.push({ name: 'remote OAuth credentials', status: 'error', message: error instanceof CredentialError
      ? error.message : 'Cannot read remote Claude OAuth credentials. Complete login on the relay host first.' });
  }
  if (offline) return checks;
  const upstream = new URL(config.upstream);
  try {
    const host = upstream.hostname.replace(/^\[|\]$/g, '');
    await Promise.race([
      lookup(host),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('DNS timeout')), 5000); timer.unref(); }),
    ]);
    if (upstream.protocol === 'https:') {
      await new Promise<void>((resolveTls, reject) => {
        const socket = connect({ host, port: Number(upstream.port || 443), servername: host });
        socket.setTimeout(5000, () => socket.destroy(new Error('TLS timeout')));
        socket.once('secureConnect', () => { socket.destroy(); resolveTls(); });
        socket.once('error', reject);
      });
    }
    checks.push({ name: 'upstream connectivity', status: 'ok', message: upstream.protocol === 'https:' ? 'DNS and TLS handshake succeeded. Authentication and model access were not tested.' : 'Loopback test upstream resolved. No inference request was sent.' });
  } catch {
    checks.push({ name: 'upstream connectivity', status: 'error', message: 'DNS or TLS handshake failed. Check connectivity and the configured upstream.' });
  }
  try {
    const response = await fetch(`${localUrl(config.host, config.port)}/healthz`, { signal: AbortSignal.timeout(2000) });
    const body: unknown = await response.json();
    const healthy = response.ok && typeof body === 'object' && body !== null && 'service' in body && body.service === 'cchop';
    checks.push({ name: 'local relay', status: healthy ? 'ok' : 'warn', message: healthy ? 'cchop is responding.' : 'The configured port did not report a healthy cchop service.' });
  } catch {
    checks.push({ name: 'local relay', status: 'warn', message: 'Relay is not reachable locally. Start it with cchop start.' });
  }
  return checks;
}
