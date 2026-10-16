import { lstat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { Agent, request } from 'undici';
import type { RuntimeConfig } from './config.js';
import { createFingerprint, saveFingerprint, type Fingerprint } from './fingerprint.js';
import { forwardHeaders, responseHeaders, verifySecret } from './security.js';

const routes = new Map([
  ['/v1/messages', 'POST'],
  ['/v1/messages/count_tokens', 'POST'],
  ['/v1/models', 'GET'],
]);

class CaptureRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function failure(res: ServerResponse, status: number, message: string): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close',
  });
  res.end(JSON.stringify({ error: { message } }));
}

function duplicateCredentials(req: IncomingMessage): boolean {
  const names = new Set(['authorization', 'x-api-key', 'x-cchop-key', 'x-cchop-admin-key']);
  const seen = new Set<string>();
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index]!.toLowerCase();
    if (!names.has(name)) continue;
    if (seen.has(name)) return true;
    seen.add(name);
  }
  return false;
}

function localRequest(req: IncomingMessage, port: number): boolean {
  if (req.socket.remoteAddress !== '127.0.0.1' || typeof req.headers.host !== 'string') return false;
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host.toLowerCase())) return false;
  if (req.headers.origin !== undefined) {
    try {
      const origin = new URL(req.headers.origin);
      if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname)
        || Number(origin.port || 80) !== port || origin.username || origin.password
        || origin.pathname !== '/' || origin.search || origin.hash) return false;
    } catch { return false; }
  }
  return true;
}

function readBody(req: IncomingMessage, limit: number, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAbort);
      signal.removeEventListener('abort', onAbort);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onAbort = () => onError(new CaptureRequestError(499, 'Capture request was cancelled.'));
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        req.resume();
        reject(new CaptureRequestError(413, 'Request body exceeds the configured limit.'));
      } else chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolveBody(Buffer.concat(chunks, size)); };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export interface CapturedExchange {
  upstreamStatus: number | null;
  error: string | null;
}

export interface RunningCapture {
  port: number;
  /** Settles after the captured exchange; an explicit close before capture also resolves it. */
  completed: Promise<void>;
  /** Available after the captured exchange, including provider errors and interrupted streams. */
  readonly exchange: CapturedExchange | null;
  close(): Promise<void>;
}

export async function startCapture(config: RuntimeConfig, options: {
  port?: number;
  replace?: boolean;
  onCaptured?: (fingerprint: Fingerprint) => void;
} = {}): Promise<RunningCapture> {
  const requestedPort = options.port ?? 9999;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error('Capture port must be an integer between 0 and 65535.');
  }
  if (!options.replace) {
    try {
      await lstat(config.fingerprintPath);
      throw new Error('A fingerprint already exists. Use capture --replace to replace it.');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }

  let resolveCompleted!: () => void;
  let rejectCompleted!: (error: Error) => void;
  const completed = new Promise<void>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  // A filesystem failure can occur before a caller starts awaiting completed.
  void completed.catch(() => undefined);
  const agent = new Agent({ connections: config.maxConcurrent, pipelining: 1 });
  const controllers = new Set<AbortController>();
  const active = new Set<Promise<void>>();
  let port = requestedPort;
  let reserved = false;
  let exchange: CapturedExchange | null = null;
  let closing: Promise<void> | undefined;

  async function proxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!localRequest(req, port)) { failure(res, 403, 'Capture accepts only local requests.'); return; }
    let url: URL;
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new Error('Invalid target');
      url = new URL(req.url, 'http://cchop.local');
    } catch { failure(res, 400, 'Invalid request target.'); return; }
    if (closing) { failure(res, 503, 'Capture is closing.'); return; }
    if (url.pathname === '/api/hello' && req.method === 'HEAD') {
      res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return;
    }
    if (duplicateCredentials(req)) { failure(res, 400, 'Duplicate credential headers are not accepted.'); return; }
    const authorization = /^Bearer ([^\s\x00-\x1f\x7f]+)$/i.exec(req.headers.authorization ?? '');
    if (!authorization || verifySecret(authorization[1], config.gatewayToken)
      || verifySecret(authorization[1], config.adminToken)) {
      failure(res, 401, 'Capture requires the remote Claude Code OAuth bearer token.'); return;
    }
    const method = routes.get(url.pathname);
    if (!method) { failure(res, 404, 'This endpoint is not served by capture.'); return; }
    if (req.method !== method) { res.setHeader('allow', method); failure(res, 405, 'Method not allowed.'); return; }
    if (controllers.size >= config.maxConcurrent) {
      res.setHeader('retry-after', '1'); failure(res, 429, 'Capture concurrency limit reached.'); return;
    }
    if (url.pathname === '/v1/messages' && reserved) {
      failure(res, 409, 'A request has already been selected for this capture.'); return;
    }
    if (method === 'POST' && !/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] ?? '')) {
      failure(res, 415, 'Content-Type must be application/json.'); return;
    }
    if (method === 'POST' && req.headers['content-encoding'] !== undefined
      && req.headers['content-encoding'].toLowerCase() !== 'identity') {
      failure(res, 415, 'Capture requires an uncompressed JSON request.'); return;
    }
    if (Number(req.headers['content-length'] ?? 0) > config.maxRequestBytes) {
      failure(res, 413, 'Request body exceeds the configured limit.'); return;
    }
    if (method === 'GET' && (Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'])) {
      failure(res, 400, 'GET requests must not contain a body.'); return;
    }

    const controller = new AbortController();
    controllers.add(controller);
    let captured = false;
    let upstreamStatus: number | null = null;
    let exchangeError: string | null = null;
    const onClose = () => { if (!res.writableFinished) controller.abort(); };
    const onAbort = () => controller.abort();
    res.once('close', onClose);
    req.once('aborted', onAbort);
    try {
      const body = method === 'POST' ? await readBody(req, config.maxRequestBytes, controller.signal) : undefined;
      if (controller.signal.aborted) throw new CaptureRequestError(499, 'Capture request was cancelled.');
      if (url.pathname === '/v1/messages') {
        let fingerprint: Fingerprint;
        try { fingerprint = createFingerprint(req.headers, body!); }
        catch { throw new CaptureRequestError(400, 'Capture requires a user-agent and JSON metadata.user_id containing device_id and account_uuid, with matching session IDs when both are present. Use a current Claude Code client.'); }
        // Reserve synchronously before saving: simultaneous valid requests cannot replace each other.
        if (reserved) throw new CaptureRequestError(409, 'A request has already been selected for this capture.');
        reserved = true;
        try { await saveFingerprint(config.fingerprintPath, fingerprint, { replace: options.replace }); }
        catch {
          const error = new Error('Cannot save the captured fingerprint. Check the configured path, permissions, and --replace option.');
          rejectCompleted(error);
          throw new CaptureRequestError(500, error.message);
        }
        captured = true;
        options.onCaptured?.(fingerprint);
      }
      const destination = new URL(config.upstream);
      destination.pathname = url.pathname;
      destination.search = url.search;
      const upstream = await request(destination, {
        method: method as 'POST' | 'GET', headers: forwardHeaders(req.headers), body,
        dispatcher: agent, signal: controller.signal,
        headersTimeout: config.headersTimeoutMs, bodyTimeout: config.streamIdleTimeoutMs,
      });
      // Destroying a rejected response must not produce an unhandled stream error.
      upstream.body.on('error', () => undefined);
      upstreamStatus = upstream.statusCode;
      if (upstreamStatus >= 300 && upstreamStatus < 400) {
        upstream.body.destroy();
        throw new CaptureRequestError(502, 'Upstream redirects are not accepted. Configure the final upstream origin.');
      }
      res.writeHead(upstreamStatus, responseHeaders(upstream.headers));
      res.flushHeaders();
      await pipeline(upstream.body, res, { signal: controller.signal });
    } catch (error) {
      const status = error instanceof CaptureRequestError ? error.status : 502;
      exchangeError = error instanceof CaptureRequestError ? error.message : 'Upstream request failed or the stream was interrupted.';
      if (!res.headersSent) failure(res, status, exchangeError);
      else if (!res.destroyed) res.destroy();
    } finally {
      controllers.delete(controller);
      res.off('close', onClose);
      req.off('aborted', onAbort);
      if (captured) {
        exchange = { upstreamStatus, error: exchangeError };
        resolveCompleted();
      }
    }
  }

  const server = createServer({ maxHeaderSize: 16384 }, (req, res) => {
    const task = proxy(req, res).catch(() => {
      if (!res.headersSent) failure(res, 500, 'Unexpected capture error.');
      else res.destroy();
    });
    active.add(task);
    void task.finally(() => active.delete(task));
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 30000;

  function close(): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      for (const controller of controllers) controller.abort();
      const deadline = setTimeout(() => server.closeAllConnections(), config.shutdownGraceMs);
      deadline.unref();
      try {
        if (server.listening) {
          await new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
            server.closeIdleConnections();
          });
        }
        await Promise.allSettled(active);
        await agent.destroy();
      } finally {
        clearTimeout(deadline);
        resolveCompleted();
      }
    })();
    return closing;
  }

  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(requestedPort, '127.0.0.1', () => {
        server.off('error', reject);
        port = (server.address() as AddressInfo).port;
        resolveListen();
      });
    });
    return { port, completed, get exchange() { return exchange; }, close };
  } catch (error) {
    await close();
    throw error;
  }
}
