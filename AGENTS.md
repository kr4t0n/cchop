# cchop contributor context

cchop is a global npm CLI implementing the source document's personal Claude Code subscription relay: capture a remote request identity once, then rewrite incoming client requests and manage the remote subscription OAuth credentials. The user explicitly requested this architecture, replacing the earlier passthrough proxy. The application and bundled React dashboard run in one foreground process. Infrastructure and container packaging remain outside this repository.

## Architecture

- `src/cli.ts`: initialization, separate one-time capture, foreground relay/dashboard startup, diagnostics, and private client settings generation.
- `src/config.ts`: strict configuration, external state paths, and environment-backed relay/admin keys. Relative state paths resolve against the configuration directory.
- `src/capture.ts`: loopback-only HTTP capture of the first valid remote Claude messages request. Forward the original request and stream its response, then exit; never refresh credentials during capture.
- `src/fingerprint.ts`: validate and atomically persist sanitized captured headers, complete metadata user ID, capture time, and Node version. No prompts or provider credentials belong in a fingerprint.
- `src/rewriter.ts`: strip client identity headers, apply the captured headers, replace metadata.user_id when metadata exists, and inject the remote OAuth token last.
- `src/credentials.ts`: reread remote Claude credentials for every request; serialize early refresh with one in-process promise; atomically persist both rotated tokens and expiry before releasing the new access token.
- `src/server.ts`: independent relay/admin listeners, bounded proxying, streaming, cancellation, lifecycle, and sanitized diagnostics.
- `src/types.ts`, `src/metrics.ts`: bounded request metadata and dashboard status. `GET /api/status` requires `X-Cchop-Admin-Key`.
- `web/`: React, TypeScript, Vite, and Tailwind operations dashboard, built into the npm package.
- `test/`, `scripts/`: local protocol/credential/capture/CLI checks and foreground-supervised package/browser smoke checks. Never read actual user credentials or use real provider tokens in automated tests.

## Required mechanism

- The source document is https://bytedance.larkoffice.com/wiki/OkVnw34DTilaLMkaUI5ceE7enbf. Honor its capture → strip local identity → apply remote identity → replace OAuth → stream response flow. Do not substitute client-authentication passthrough again.
- The local client's `ANTHROPIC_AUTH_TOKEN` is the relay key. Authenticate it with constant-time hash comparison, strip it, and set upstream Authorization to the remote access token. The generated client settings contain only the relay URL and shared relay key.
- Capture omits authorization, API keys, cookies, gateway keys, hop-by-hop headers, and forwarded addresses. Captured headers intentionally replace current local beta/version/runtime headers; do not merge local capabilities into a frozen capture.
- Rewrite the complete captured metadata.user_id while preserving other JSON fields. Reject malformed/compressed requests instead of forwarding an identity that cannot be rewritten. Do not forward stale content length.
- Refresh within five minutes of expiry, persist both access and refresh tokens plus expiry, preserve unrelated credential metadata, and fail with 503 if refresh or persistence fails. Never log response bodies or token values. Do not automatically retry inference or redirect authenticated traffic.
- One person, one subscription, one relay process. Stop remote Claude Code before starting the relay so credential writes have a single owner. Capture runs only while relay service is stopped; upgrades require explicit recapture.
- The only authentication mode is `subscription`. Old `passthrough`/`api-key` configuration is rejected with migration instructions. Authentication behavior must never change silently.
- Admin defaults to a separate loopback listener and independent secret. Prompt content, metadata.user_id, and credentials must never appear in logs or retained history. Process supervision and network setup belong to the operator.

## Conventions

- TypeScript, ESM, explicit `.js` extensions for server imports; exact dependency versions and lockfile.
- Run ESLint, type checks, build, and meaningful tests after changing code. Run package/browser checks when their paths or contracts change.
- Update README and this architecture description with behavior and setup changes.
- Package only compiled application assets and documentation. Keep `.env`, fingerprint.json, Claude credentials, local client settings, npm authentication, and local configuration out of git and package tarballs.
- Publishing the npm package requires explicit user authorization.

## Gotchas and limits

- Default Claude credential storage follows the document's Linux JSON format. Keychain extraction is not implemented. A custom CLAUDE_CONFIG_DIR must be reflected in cchop's explicit credential path.
- Capture exits after its first selected exchange, including provider errors; saving a fingerprint does not establish successful provider authentication. A non-successful captured exchange is reported by the CLI.
- Align the relay Node major version with capture. The stored version describes cchop's capture process, not a verified match to the Claude executable's embedded TLS stack. No guarantee of TLS equivalence or account-enforcement outcomes is made.
- OAuth refresh has one in-process owner. Concurrent independent processes writing the same file are unsupported. A stale backup refresh token may be revoked; recover with a new remote login rather than assuming rollback works.
- Configuration JSON, gateway credential file, fingerprint, and Claude credential paths must be distinct. Fingerprints are loaded at startup; OAuth credentials are reread per request.
- Capture never retains prompts. Runtime history is bounded and per process; restarting clears it. Latency covers only retained requests.
- A configured base URL does not control every Claude Code network endpoint; login and auxiliary features may use other routes.
- Mock protocol and rotation tests do not prove live subscription compatibility. Do not claim live validation unless it was actually performed with the operator's authorization.
- Graceful shutdown has a deadline; remaining streams and OAuth network work are cancelled at that deadline. Once a rotated OAuth response has been validated, finish its atomic credential commit even during shutdown so rotation is not lost.
- A locally installed tarball is not a published package, and the npm name is not reserved.

## Planned improvements

Validate the personal single-instance workflow before adding persistent metrics. Keep infrastructure orchestration, account pools, and multi-user subscription credential management outside this project.
