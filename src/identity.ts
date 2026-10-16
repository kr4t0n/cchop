import { z } from 'zod';

export const SESSION_ID_HEADER = 'x-claude-code-session-id';

const identityField = z.string().max(8192).regex(/^[^\x00-\x1f\x7f]*$/);
export const capturedIdentitySchema = z.object({
  device_id: identityField.min(1),
  // Claude Code can send an empty account UUID when no account profile is cached.
  account_uuid: identityField,
}).strict();
export type CapturedIdentity = z.infer<typeof capturedIdentitySchema>;
export class IdentityError extends Error {}

// Correlation IDs and future Claude request hints must not be frozen.
export function isRequestScopedHeader(name: string): boolean {
  return name.startsWith('x-claude-code-');
}

export function parseMetadataUserId(value: unknown, sessionHeader?: string | string[]): Record<string, unknown> {
  let identity: unknown;
  if (typeof value === 'string' && value.length <= 8192) {
    try { identity = JSON.parse(value); }
    catch { /* Keep malformed identity values out of diagnostics. */ }
  }
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new IdentityError('metadata.user_id must be a JSON-encoded object.');
  }
  const parsed = identity as Record<string, unknown>;
  const validSession = (id: unknown) => typeof id === 'string' && /^[\x21-\x7e]{1,256}$/.test(id);
  if ((sessionHeader !== undefined && !validSession(sessionHeader))
    || ('session_id' in parsed && !validSession(parsed.session_id))) {
    throw new IdentityError('Session IDs must be nonempty strings of at most 256 printable ASCII characters without spaces.');
  }
  if (sessionHeader !== undefined && 'session_id' in parsed && parsed.session_id !== sessionHeader) {
    throw new IdentityError('x-claude-code-session-id must match session_id in metadata.user_id when both are present.');
  }
  return parsed;
}
