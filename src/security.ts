import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export function verifySecret(value: string | string[] | undefined, expected: string): boolean {
  if (typeof value !== 'string' || !expected || value.length > 4096) return false;
  const hash = (input: string) => createHash('sha256').update(input, 'utf8').digest();
  return timingSafeEqual(hash(value), hash(expected));
}

export function verifyBearer(value: string | string[] | undefined, expected: string): boolean {
  return typeof value === 'string' && value.startsWith('Bearer ') && verifySecret(value.slice(7), expected);
}

const hopHeaders = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'host', 'content-length', 'x-cchop-key', 'x-cchop-admin-key',
]);

export function forwardHeaders(incoming: IncomingHttpHeaders): Record<string, string | string[]> {
  const nominated = new Set(String(incoming.connection ?? '').toLowerCase().split(',').map((name) => name.trim()));
  const output: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(incoming)) {
    const name = key.toLowerCase();
    if (value === undefined || hopHeaders.has(name) || nominated.has(name)) continue;
    if (name === 'forwarded' || name.startsWith('x-forwarded-') || name === 'x-real-ip') continue;
    output[name] = value;
  }
  return output;
}

export function responseHeaders(incoming: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
  const output = forwardHeaders(incoming);
  delete output['set-cookie'];
  return output;
}
