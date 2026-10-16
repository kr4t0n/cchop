import type { IncomingHttpHeaders } from 'node:http';
import type { Fingerprint } from './fingerprint.js';
import { IdentityError, parseMetadataUserId, type CapturedIdentity } from './identity.js';
import { forwardHeaders } from './security.js';

const identityHeaders = new Set([
  'user-agent', 'x-app', 'anthropic-version', 'anthropic-beta', 'sec-fetch-mode',
  'authorization', 'x-api-key', 'cookie',
]);

export class RewriteError extends Error {}

export function rewriteHeaders(incoming: IncomingHttpHeaders, fingerprint: Fingerprint, accessToken: string): Record<string, string | string[]> {
  const headers = forwardHeaders(incoming);
  for (const key of Object.keys(headers)) {
    if (identityHeaders.has(key) || key.startsWith('x-stainless-')) delete headers[key];
  }
  Object.assign(headers, fingerprint.headers);
  headers.authorization = `Bearer ${accessToken}`;
  return headers;
}

export function rewriteBody(raw: Buffer, capturedIdentity: CapturedIdentity, sessionHeader?: string | string[]): Buffer {
  let body: unknown;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch { throw new RewriteError('Request body must be valid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RewriteError('Request body must be a JSON object.');
  if ('metadata' in body) {
    if (!body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata)) {
      throw new RewriteError('Request metadata must be a JSON object.');
    }
    if ('user_id' in body.metadata) {
      let identity: Record<string, unknown>;
      try { identity = parseMetadataUserId(body.metadata.user_id, sessionHeader); }
      catch (error) {
        throw new RewriteError(error instanceof IdentityError ? error.message : 'Invalid metadata.user_id.');
      }
      identity.device_id = capturedIdentity.device_id;
      identity.account_uuid = capturedIdentity.account_uuid;
      body.metadata.user_id = JSON.stringify(identity);
    }
  }
  return Buffer.from(JSON.stringify(body), 'utf8');
}
