import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFingerprint, FingerprintError, loadFingerprint } from '../src/fingerprint.js';

test('loading a versioned fingerprint rejects invalid identity and persisted request correlation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cchop-fingerprint-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'fingerprint.json');
  const fingerprint = {
    schemaVersion: 2, capturedAt: new Date().toISOString(), nodeVersion: process.version,
    headers: { 'user-agent': 'claude-cli/test' },
    identity: { device_id: 'private-device', account_uuid: 'private-account' },
  };
  const invalid = [
    ...[undefined, null, 'old-opaque-identity', {}, { device_id: 'private-device' }, { device_id: '', account_uuid: 'private-account' },
      { device_id: 'private-device', account_uuid: 42 }, { ...fingerprint.identity, session_id: 'private-session' },
    ].map((identity) => ({ ...fingerprint, identity })),
    { ...fingerprint, metadataUserId: 'old-opaque-identity' },
    ...[
      'x-claude-code-session-id', 'x-claude-code-agent-id', 'x-claude-code-parent-agent-id', 'x-claude-code-prompt-id',
      'x-claude-code-request-class', 'x-claude-code-agent-type', 'x-claude-code-compaction',
      'x-claude-code-context-compacted', 'x-claude-code-prev-tool-durations', 'x-claude-code-future-hint',
    ].map((name) => ({ ...fingerprint, headers: { ...fingerprint.headers, [name]: 'private-value' } })),
  ];
  for (const value of invalid) {
    const serialized = JSON.stringify(value);
    await writeFile(path, serialized, { mode: 0o600 });
    await assert.rejects(loadFingerprint(path), (error: unknown) => {
      assert.ok(error instanceof FingerprintError);
      assert.match(error.message, /cchop capture --replace/);
      for (const secret of ['private-session', 'private-device', 'private-account', 'private-value', 'old-opaque-identity']) {
        assert.equal(error.message.includes(secret), false);
      }
      return true;
    });
    assert.equal(await readFile(path, 'utf8'), serialized);
  }
});

test('capture extracts only device and account fields with optional session correlation', () => {
  for (const accountUuid of ['remote-account', '']) {
    for (const bodySession of [undefined, 'capture-session']) {
      for (const headerSession of [undefined, 'capture-session']) {
        const fingerprint = createFingerprint({ 'user-agent': 'claude-cli/test', 'x-claude-code-session-id': headerSession },
          Buffer.from(JSON.stringify({ metadata: { user_id: JSON.stringify({
            device_id: 'remote-device', account_uuid: accountUuid, session_id: bodySession, future_field: 'capture-only-metadata',
          }) } })));
        assert.deepEqual(fingerprint.identity, { device_id: 'remote-device', account_uuid: accountUuid });
        assert.deepEqual(fingerprint.headers, { 'user-agent': 'claude-cli/test' });
        assert.equal(JSON.stringify(fingerprint).includes('capture-session'), false);
        assert.equal(JSON.stringify(fingerprint).includes('capture-only-metadata'), false);
      }
    }
  }
});
