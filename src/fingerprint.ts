import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { validateHeaderName, validateHeaderValue, type IncomingHttpHeaders } from 'node:http';
import { dirname } from 'node:path';
import { z } from 'zod';
import { capturedIdentitySchema, isRequestScopedHeader, parseMetadataUserId, SESSION_ID_HEADER } from './identity.js';
import { forwardHeaders } from './security.js';

export const FINGERPRINT_SCHEMA_VERSION = 2;

const fingerprintSchema = z.object({
  schemaVersion: z.literal(FINGERPRINT_SCHEMA_VERSION),
  capturedAt: z.iso.datetime(),
  nodeVersion: z.string().regex(/^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/),
  headers: z.record(z.string().min(1).max(256), z.string().max(16384)),
  identity: capturedIdentitySchema,
}).strict();

export type Fingerprint = z.infer<typeof fingerprintSchema>;
export class FingerprintError extends Error {}

// Credentials, transport metadata, and per-request hints are not reusable identity.
function captureHeaders(incoming: IncomingHttpHeaders): Record<string, string> {
  const filtered = forwardHeaders(incoming);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(filtered)) {
    if (['authorization', 'x-api-key', 'cookie', 'set-cookie', 'content-encoding'].includes(key)
      || isRequestScopedHeader(key)) continue;
    if (typeof value !== 'string') throw new FingerprintError('Capture requires single-valued HTTP headers.');
    try { validateHeaderName(key); validateHeaderValue(key, value); }
    catch { throw new FingerprintError('Fingerprint contains invalid HTTP headers.'); }
    headers[key] = value;
  }
  return headers;
}

function validateFingerprint(value: unknown): Fingerprint {
  if (value && typeof value === 'object' && !Array.isArray(value)
    && (!('schemaVersion' in value) || value.schemaVersion !== FINGERPRINT_SCHEMA_VERSION)) {
    throw new FingerprintError('Unsupported fingerprint format. Stop the relay and run cchop capture --replace with a current Claude Code client.');
  }
  const parsed = fingerprintSchema.safeParse(value);
  if (!parsed.success) throw new FingerprintError('Fingerprint is invalid. Stop the relay and run cchop capture --replace with the remote Claude Code client.');
  const headers = captureHeaders(parsed.data.headers);
  if (!headers['user-agent'] || Object.keys(headers).length !== Object.keys(parsed.data.headers).length
    || Object.keys(parsed.data.headers).some((key) => key !== key.toLowerCase())) {
    throw new FingerprintError('Fingerprint must contain a user-agent and no credentials, transport headers, or per-request headers. Stop the relay and run cchop capture --replace.');
  }
  return { ...parsed.data, headers };
}

export function createFingerprint(headers: IncomingHttpHeaders, rawBody: Buffer): Fingerprint {
  let body: unknown;
  try { body = JSON.parse(rawBody.toString('utf8')); }
  catch { throw new FingerprintError('Capture requires a valid JSON messages request.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('metadata' in body)
    || !body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata)
    || !('user_id' in body.metadata)) {
    throw new FingerprintError('Capture requires the remote Claude Code metadata.user_id.');
  }
  let identity: Record<string, unknown>;
  try { identity = parseMetadataUserId(body.metadata.user_id, headers[SESSION_ID_HEADER]); }
  catch { throw new FingerprintError('Capture requires JSON metadata.user_id with consistent session IDs. Use a current Claude Code client.'); }
  return validateFingerprint({
    schemaVersion: FINGERPRINT_SCHEMA_VERSION,
    capturedAt: new Date().toISOString(), nodeVersion: process.version,
    headers: captureHeaders(headers), identity: { device_id: identity.device_id, account_uuid: identity.account_uuid },
  });
}

export async function loadFingerprint(path: string): Promise<Fingerprint> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 256 * 1024) throw new FingerprintError('Fingerprint must be a JSON file smaller than 256 KiB.');
    return validateFingerprint(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (error instanceof FingerprintError) throw error;
    throw new FingerprintError('Cannot read a valid fingerprint. Run cchop capture on the relay host before starting.');
  }
}

export async function saveFingerprint(path: string, fingerprint: Fingerprint, options: { replace?: boolean } = {}): Promise<void> {
  const validated = validateFingerprint(fingerprint);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(validated, null, 2)}\n`); await file.sync(); }
    finally { await file.close(); }
    if (options.replace) await rename(temporary, path);
    else await link(temporary, path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new FingerprintError('A fingerprint already exists. Stop the relay and use cchop capture --replace to recapture.');
    }
    throw new FingerprintError('Could not save the captured fingerprint. Check its directory permissions.');
  } finally { await unlink(temporary).catch(() => undefined); }
}

export function runtimeWarning(fingerprint: Fingerprint): string | undefined {
  if (fingerprint.nodeVersion.replace(/^v/, '').split('.')[0] !== process.versions.node.split('.')[0]) {
    return `Capture used Node ${fingerprint.nodeVersion}; relay uses ${process.version}. Align the Node major version with capture.`;
  }
  return undefined;
}
