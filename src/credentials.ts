import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Agent, request } from 'undici';

const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_REFRESH_BEFORE_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMESTAMP_MS = 8640000000000000;

export interface ClaudeOAuthCredentials extends Record<string, unknown> {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshTokenExpiresAt?: number;
  scopes?: string[];
  clientId?: string;
}

export interface ClaudeCredentials extends Record<string, unknown> {
  claudeAiOauth: ClaudeOAuthCredentials;
}

export class CredentialError extends Error {
  constructor(message = 'Cannot use the relay Claude credentials.') {
    super(message);
    this.name = 'CredentialError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 16384 && /^[\x21-\x7e]+$/.test(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP_MS;
}

function isScope(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 16384 && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(value);
}

function parseCredentials(serialized: string): ClaudeCredentials {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new CredentialError('The relay Claude credential file must contain valid JSON.');
  }
  const oauth = isObject(value) ? value.claudeAiOauth : undefined;
  if (!isObject(value) || !isObject(oauth) || !isToken(oauth.accessToken) || !isToken(oauth.refreshToken)
    || !isTimestamp(oauth.expiresAt)
    || (oauth.refreshTokenExpiresAt !== undefined && !isTimestamp(oauth.refreshTokenExpiresAt))
    || (oauth.clientId !== undefined && !isToken(oauth.clientId))
    || (oauth.scopes !== undefined && (!Array.isArray(oauth.scopes) || !oauth.scopes.every(isScope)))) {
    throw new CredentialError('The relay Claude credential file has invalid or missing OAuth fields.');
  }
  return value as ClaudeCredentials;
}

function parseRefreshResponse(value: unknown, previous: ClaudeOAuthCredentials): ClaudeOAuthCredentials {
  const invalid = () => new CredentialError('Claude OAuth refresh returned invalid credentials.');
  if (!isObject(value) || !isToken(value.access_token)
    || (value.refresh_token !== undefined && !isToken(value.refresh_token))) throw invalid();
  const now = Date.now();
  const expiresAt = typeof value.expires_in === 'number' ? Math.floor(now + value.expires_in * 1000) : NaN;
  if (!isTimestamp(expiresAt) || expiresAt <= now) throw invalid();
  const updated: ClaudeOAuthCredentials = {
    ...previous,
    accessToken: value.access_token,
    refreshToken: value.refresh_token === undefined ? previous.refreshToken : value.refresh_token,
    expiresAt,
  };
  if (value.scope !== undefined) {
    if (typeof value.scope !== 'string') throw invalid();
    const scopes = value.scope.split(' ').filter(Boolean);
    if (!scopes.every(isScope)) throw invalid();
    updated.scopes = scopes;
  }
  if (value.refresh_token_expires_in !== undefined) {
    const lifetime = value.refresh_token_expires_in;
    const refreshExpiresAt = typeof lifetime === 'number' ? Math.floor(now + lifetime * 1000) : NaN;
    if (typeof lifetime !== 'number' || lifetime < 0 || !isTimestamp(refreshExpiresAt)) throw invalid();
    updated.refreshTokenExpiresAt = refreshExpiresAt;
  }
  return updated;
}

async function readSnapshot(path: string): Promise<{ credentials: ClaudeCredentials; serialized: string }> {
  let file;
  let serialized: string;
  try {
    file = await open(path, 'r');
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > MAX_CREDENTIAL_BYTES) throw new Error();
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(65536, MAX_CREDENTIAL_BYTES + 1 - size));
      const { bytesRead } = await file.read(buffer);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > MAX_CREDENTIAL_BYTES) throw new Error();
      chunks.push(buffer.subarray(0, bytesRead));
    }
    serialized = Buffer.concat(chunks).toString('utf8');
  } catch {
    throw new CredentialError('Cannot read the relay Claude credential file. Check its path, size, and permissions.');
  } finally {
    await file?.close().catch(() => undefined);
  }
  return { credentials: parseCredentials(serialized), serialized };
}

/** Read only the explicitly configured file; never discover other accounts or credential stores. */
export async function readCredentials(path: string): Promise<ClaudeCredentials> {
  return (await readSnapshot(path)).credentials;
}

export interface CredentialProviderOptions {
  path: string;
  tokenUrl: string;
  clientId: string;
  refreshBeforeMs?: number;
  timeoutMs?: number;
  onEvent?: (event: { event: 'oauth_refresh'; status: 'ok' | 'error' }) => void;
}

export interface CredentialProvider {
  getAccessToken(): Promise<string>;
  close(): Promise<void>;
}

function validateTokenUrl(value: string): URL {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      || url.username || url.password || url.search || url.hash) throw new Error();
    return url;
  } catch {
    throw new CredentialError('The OAuth token URL must use HTTPS without credentials, a query, or a fragment; HTTP is allowed only for loopback testing.');
  }
}

async function persistCredentials(
  path: string,
  previous: string,
  credentials: ClaudeCredentials,
): Promise<void> {
  const temporaryPath = join(dirname(path), `.cchop-credentials-${randomUUID()}.tmp`);
  let temporary;
  try {
    const serialized = `${JSON.stringify(credentials, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_CREDENTIAL_BYTES) throw new Error();
    temporary = await open(temporaryPath, 'wx', 0o600);
    await temporary.writeFile(serialized, 'utf8');
    await temporary.sync();
    await temporary.close();
    temporary = undefined;
    // A login or another writer may have replaced credentials while OAuth was in flight.
    // Do not overwrite that newer state with this request's result.
    if ((await readSnapshot(path)).serialized !== previous) {
      throw new CredentialError('The relay Claude credentials changed during refresh. Retry using the current credential file.');
    }
    await rename(temporaryPath, path);
  } catch (error) {
    if (error instanceof CredentialError) throw error;
    throw new CredentialError('Cannot persist refreshed Claude credentials. Check the relay credential file permissions.');
  } finally {
    await temporary?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export function createCredentialProvider(options: CredentialProviderOptions): CredentialProvider {
  const tokenUrl = validateTokenUrl(options.tokenUrl);
  const refreshBeforeMs = options.refreshBeforeMs ?? DEFAULT_REFRESH_BEFORE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!options.path || !isToken(options.clientId) || !Number.isSafeInteger(refreshBeforeMs) || refreshBeforeMs < 0
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) {
    throw new CredentialError('Invalid Claude credential provider configuration.');
  }
  let closed = false;
  let inFlight: Promise<string> | undefined;
  let refreshAbort: AbortController | undefined;
  // A dedicated dispatcher has no redirect or retry interceptor and is closed
  // with this provider, independently of any process-global HTTP configuration.
  const agent = new Agent({ connections: 1 });

  function emit(status: 'ok' | 'error'): void {
    try {
      options.onEvent?.({ event: 'oauth_refresh', status });
    } catch {
      // Logging must not interrupt credential persistence or expose its own error context.
    }
  }

  function assertOpen(): void {
    if (closed) throw new CredentialError('The Claude credential provider is closed.');
  }

  async function refresh(snapshot: Awaited<ReturnType<typeof readSnapshot>>): Promise<string> {
    assertOpen();
    const controller = new AbortController();
    refreshAbort = controller;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref();
    let persisted = false;
    try {
      const previous = snapshot.credentials.claudeAiOauth;
      const response = await request(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: previous.refreshToken,
          client_id: previous.clientId ?? options.clientId,
          ...(previous.scopes?.length ? { scope: previous.scopes.join(' ') } : {}),
        }),
        signal: controller.signal,
        dispatcher: agent,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });
      response.body.on('error', () => undefined);
      let value: unknown;
      try {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw new CredentialError('Claude OAuth refresh was rejected. Sign in again on the relay host if the credentials are no longer valid.');
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) throw new CredentialError('Claude OAuth refresh returned an oversized response.');
          chunks.push(Buffer.from(chunk));
        }
        try {
          value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          throw new CredentialError('Claude OAuth refresh returned invalid credentials.');
        }
      } finally {
        response.body.destroy();
      }
      const oauth = parseRefreshResponse(value, previous);
      // A valid response may rotate the refresh token. Cancellation must not
      // discard the credential commit even if the request cannot use it.
      clearTimeout(timeout);
      if (refreshAbort === controller) refreshAbort = undefined;
      const updated: ClaudeCredentials = {
        ...snapshot.credentials,
        claudeAiOauth: oauth,
      };
      await persistCredentials(options.path, snapshot.serialized, updated);
      persisted = true;
      emit('ok');
      assertOpen();
      return updated.claudeAiOauth.accessToken;
    } catch (error) {
      if (!persisted) emit('error');
      if (error instanceof CredentialError) throw error;
      throw new CredentialError('Claude OAuth refresh failed or timed out.');
    } finally {
      clearTimeout(timeout);
      if (refreshAbort === controller) refreshAbort = undefined;
    }
  }

  return {
    async getAccessToken(): Promise<string> {
      assertOpen();
      const snapshot = await readSnapshot(options.path);
      assertOpen();
      if (inFlight) return inFlight;
      if (snapshot.credentials.claudeAiOauth.expiresAt > Date.now() + refreshBeforeMs) {
        return snapshot.credentials.claudeAiOauth.accessToken;
      }
      const operation = (async () => {
        // Re-read after taking the singleflight slot: a slow reader may hold the old
        // file even though a prior refresh already persisted and released its slot.
        const current = await readSnapshot(options.path);
        assertOpen();
        if (current.credentials.claudeAiOauth.expiresAt > Date.now() + refreshBeforeMs) {
          return current.credentials.claudeAiOauth.accessToken;
        }
        return refresh(current);
      })();
      inFlight = operation;
      try {
        return await operation;
      } finally {
        if (inFlight === operation) inFlight = undefined;
      }
    },
    async close(): Promise<void> {
      closed = true;
      refreshAbort?.abort();
      await inFlight?.catch(() => undefined);
      await agent.destroy();
    },
  };
}
