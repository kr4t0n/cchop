import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { Agent, request } from 'undici';
import { VERSION, type RuntimeConfig } from './config.js';
import { createCredentialProvider, CredentialError, readCredentials } from './credentials.js';
import { loadFingerprint, runtimeWarning } from './fingerprint.js';
import { Metrics } from './metrics.js';
import { rewriteBody, rewriteHeaders, RewriteError } from './rewriter.js';
import { responseHeaders, verifyBearer, verifySecret } from './security.js';
import type { RequestRecord } from './types.js';

const routes = new Map([
  ['/v1/messages', 'POST'],
  ['/v1/messages/count_tokens', 'POST'],
  ['/v1/models', 'GET'],
  ['/api/oauth/usage', 'GET'],
]);

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function failure(res: ServerResponse, status: number, message: string): void {
  json(res, status, { error: { message } });
}

function hasDuplicateCredentials(req: IncomingMessage): boolean {
  const names = new Set(['x-cchop-key', 'x-cchop-admin-key', 'authorization', 'x-api-key']);
  const seen = new Set<string>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!.toLowerCase();
    if (!names.has(name)) continue;
    if (seen.has(name)) return true;
    seen.add(name);
  }
  return false;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAbort);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onAbort = () => onError(new HttpError(499, 'Client disconnected.'));
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        req.resume();
        reject(new HttpError(413, 'Request body exceeds the configured limit.'));
      } else parts.push(chunk);
    };
    const onEnd = () => { cleanup(); resolveBody(Buffer.concat(parts, size)); };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAbort);
  });
}

async function listen(server: Server, host: string, port: number): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  return (server.address() as AddressInfo).port;
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose) => {
    server.close(() => resolveClose());
    server.closeIdleConnections();
  });
}

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

export interface RunningApplication {
  relayPort: number;
  adminPort: number;
  metrics: Metrics;
  close: () => Promise<void>;
}

export async function startApplication(config: RuntimeConfig, options: {
  webDir?: string;
  log?: (record: RequestRecord) => void;
  event?: (record: Record<string, string>) => void;
} = {}): Promise<RunningApplication> {
  const webDir = options.webDir ?? fileURLToPath(new URL('../dist/web/', import.meta.url));
  try {
    await access(resolve(webDir, 'index.html'));
  } catch {
    throw new Error('The dashboard build is missing. Run npm run build in a source checkout, or reinstall the cchop package.');
  }
  const fingerprint = await loadFingerprint(config.fingerprintPath);
  await readCredentials(config.claudeCredentialsPath);
  const credentials = createCredentialProvider({
    path: config.claudeCredentialsPath, tokenUrl: config.oauthTokenUrl, clientId: config.oauthClientId,
    onEvent: (event) => options.event?.(event),
  });
  options.event?.({ event: 'fingerprint_loaded', capturedAt: fingerprint.capturedAt, userAgent: fingerprint.headers['user-agent']! });
  const warning = runtimeWarning(fingerprint);
  if (warning) options.event?.({ event: 'runtime_warning', message: warning });
  const metrics = new Metrics(config.recentRequestsLimit);
  const agent = new Agent({ connections: config.maxConcurrent, pipelining: 1 });
  const controllers = new Set<AbortController>();
  let relayPort = config.port;
  let closing: Promise<void> | undefined;

  async function proxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new Error('Invalid request target');
      url = new URL(req.url, 'http://cchop.local');
    } catch { failure(res, 400, 'Invalid request target.'); return; }
    if (['/healthz', '/readyz'].includes(url.pathname) && req.method === 'GET') {
      json(res, metrics.draining ? 503 : 200, { service: 'cchop', version: VERSION, status: metrics.draining ? 'draining' : 'ready' });
      return;
    }
    if (hasDuplicateCredentials(req)) { failure(res, 400, 'Duplicate credential headers are not accepted.'); return; }
    if (!verifyBearer(req.headers.authorization, config.gatewayToken)) {
      failure(res, 401, 'A valid relay bearer token is required.'); return;
    }
    if (url.pathname === '/api/hello' && req.method === 'HEAD') { res.writeHead(204); res.end(); return; }
    const method = routes.get(url.pathname);
    if (!method) { failure(res, 404, 'This endpoint is not served by cchop.'); return; }
    if (req.method !== method) { res.setHeader('allow', method); failure(res, 405, 'Method not allowed.'); return; }
    if (metrics.draining) { failure(res, 503, 'Relay is draining.'); return; }
    if (metrics.active >= config.maxConcurrent) {
      res.setHeader('retry-after', '1'); failure(res, 429, 'Relay concurrency limit reached.'); return;
    }
    if (method === 'POST' && !/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] ?? '')) {
      failure(res, 415, 'Content-Type must be application/json.'); return;
    }
    if (method === 'POST' && req.headers['content-encoding'] && req.headers['content-encoding'].toLowerCase() !== 'identity') {
      failure(res, 415, 'Compressed request bodies cannot be rewritten. Send uncompressed JSON.'); return;
    }
    if (Number(req.headers['content-length'] ?? 0) > config.maxRequestBytes) {
      res.setHeader('connection', 'close'); failure(res, 413, 'Request body exceeds the configured limit.'); return;
    }
    const start = performance.now();
    const record: RequestRecord = {
      id: randomUUID(), method, path: url.pathname, status: 502, outcome: 'relay_error',
      startedAt: new Date().toISOString(), durationMs: 0, bytesIn: 0, bytesOut: 0,
    };
    const controller = new AbortController();
    controllers.add(controller);
    metrics.active += 1;
    let disconnected = false;
    let upstreamBroken = false;
    const onClose = () => {
      if (!res.writableFinished) {
        if (!controller.signal.aborted && !upstreamBroken) disconnected = true;
        controller.abort();
      }
    };
    const onAbort = () => { disconnected = true; controller.abort(); };
    res.once('close', onClose);
    req.once('aborted', onAbort);
    try {
      const rawBody = method === 'POST' ? await readBody(req, config.maxRequestBytes) : undefined;
      record.bytesIn = rawBody?.length ?? 0;
      const body = rawBody === undefined ? undefined : rewriteBody(rawBody, fingerprint.identity, req.headers['x-claude-code-session-id']);
      if (body && body.length > config.maxRequestBytes) throw new HttpError(413, 'Rewritten request body exceeds the configured limit.');
      const accessToken = await credentials.getAccessToken();
      controller.signal.throwIfAborted();
      const headers = rewriteHeaders(req.headers, fingerprint, accessToken);
      const destination = new URL(config.upstream);
      destination.pathname = url.pathname;
      destination.search = url.search;
      const upstream = await request(destination, {
        method: method as 'POST' | 'GET', headers, body,
        dispatcher: agent, signal: controller.signal,
        headersTimeout: config.headersTimeoutMs, bodyTimeout: config.streamIdleTimeoutMs,
      });
      upstream.body.once('error', () => { upstreamBroken = true; });
      if (upstream.statusCode >= 300 && upstream.statusCode < 400) {
        upstream.body.destroy();
        throw new HttpError(502, 'Upstream redirects are not accepted. Configure the final upstream origin.');
      }
      record.status = upstream.statusCode;
      record.outcome = upstream.statusCode < 400 ? 'ok' : 'upstream_error';
      res.writeHead(upstream.statusCode, responseHeaders(upstream.headers));
      res.flushHeaders();
      const countBytes = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          record.bytesOut += chunk.length;
          callback(null, chunk);
        },
      });
      await pipeline(upstream.body, countBytes, res, { signal: controller.signal });
    } catch (error) {
      if (disconnected) {
        record.status = 499;
        record.outcome = 'cancelled';
      } else {
        record.status = error instanceof HttpError ? error.status : error instanceof CredentialError || metrics.draining ? 503 : error instanceof RewriteError ? 400 : 502;
        record.outcome = 'relay_error';
        if (!res.headersSent) {
          failure(res, record.status, error instanceof HttpError || error instanceof RewriteError || error instanceof CredentialError ? error.message : 'Upstream request failed or the stream was interrupted.');
        } else if (!res.destroyed) res.destroy();
      }
    } finally {
      record.durationMs = Math.round(performance.now() - start);
      metrics.active -= 1;
      controllers.delete(controller);
      res.off('close', onClose);
      req.off('aborted', onAbort);
      metrics.record(record);
      options.log?.(record);
    }
  }

  const relay = createServer({ maxHeaderSize: 16384 }, (req, res) => {
    void proxy(req, res).catch(() => {
      if (!res.headersSent) failure(res, 500, 'Unexpected relay error.');
      else res.destroy();
    });
  });
  relay.requestTimeout = 60000;
  relay.headersTimeout = 30000;
  const admin = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cache-control', 'no-store');
    void (async () => {
      const pathname = new URL(req.url ?? '/', 'http://cchop.local').pathname;
      if (req.method !== 'GET' && req.method !== 'HEAD') { failure(res, 405, 'Method not allowed.'); return; }
      if (pathname.startsWith('/api/')) {
        if (hasDuplicateCredentials(req) || !verifySecret(req.headers['x-cchop-admin-key'], config.adminToken)) {
          failure(res, 401, 'The administration key is incorrect or missing.'); return;
        }
        if (pathname === '/api/status') json(res, 200, metrics.snapshot(config, relayPort));
        else failure(res, 404, 'Unknown administration endpoint.');
        return;
      }
      const decoded = decodeURIComponent(pathname);
      if (decoded !== '/' && !decoded.startsWith('/assets/') && decoded !== '/favicon.svg') {
        failure(res, 404, 'Not found.'); return;
      }
      const path = resolve(webDir, decoded === '/' ? 'index.html' : `.${decoded}`);
      if (!path.startsWith(resolve(webDir) + sep)) { failure(res, 404, 'Not found.'); return; }
      try {
        const info = await stat(path);
        if (!info.isFile()) { failure(res, 404, 'Not found.'); return; }
        res.setHeader('content-type', mimeTypes[extname(path)] ?? 'application/octet-stream');
        res.setHeader('content-length', info.size);
        if (req.method === 'HEAD') { res.end(); return; }
        await pipeline(createReadStream(path), res);
      } catch {
        if (!res.headersSent) failure(res, 404, 'Not found.');
        else res.destroy();
      }
    })().catch(() => {
      if (!res.headersSent) failure(res, 400, 'Invalid request.');
      else res.destroy();
    });
  });
  admin.requestTimeout = 10000;
  admin.headersTimeout = 10000;
  async function close(): Promise<void> {
    if (closing) return closing;
    metrics.draining = true;
    closing = (async () => {
      const deadline = setTimeout(() => {
        for (const controller of controllers) controller.abort();
        void credentials.close();
        relay.closeAllConnections();
        admin.closeAllConnections();
      }, config.shutdownGraceMs);
      deadline.unref();
      try {
        await Promise.all([closeServer(relay), closeServer(admin)]);
        await credentials.close();
        await agent.close();
      } finally { clearTimeout(deadline); }
    })();
    return closing;
  }
  try {
    relayPort = await listen(relay, config.host, config.port);
    const adminPort = await listen(admin, config.adminHost, config.adminPort);
    return { relayPort, adminPort, metrics, close };
  } catch (error) {
    await close();
    throw error;
  }
}
