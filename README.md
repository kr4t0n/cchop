# cchop

cchop is a personal Claude Code subscription relay distributed as a global npm CLI. It implements the two-stage design in [the source document](https://bytedance.larkoffice.com/wiki/OkVnw34DTilaLMkaUI5ceE7enbf): capture the remote Claude Code request identity once, then run a relay that rewrites incoming requests and owns the remote OAuth refresh lifecycle. `cchop start` runs the relay and its bundled operations dashboard in one foreground process.

The local client holds only the relay URL and shared relay key. Subscription credentials stay on the relay host. Configuration, captured identity, and secrets live outside the npm installation directory. Hosting and infrastructure configuration belong outside this repository.

## Install

Requires Node.js **22.19 or newer** and npm. Capture also requires an installed, logged-in Claude Code client on the relay host. The document uses the Linux credential file; cchop requires that file format and does not read the macOS Keychain.

Install the CLI and bundled dashboard from npm:

```bash
npm install -g cchop
cchop --version
```

Installation does not start services or modify Claude credentials. To install from a source checkout instead:

```bash
npm ci
npm run check
npm pack
npm install -g ./cchop-0.1.0.tgz
```

## First-time setup on the relay host

Create cchop configuration and independent random relay/dashboard keys:

```bash
cchop init
```

By default this creates `~/.config/cchop/cchop.json` and the private sibling `credentials.env`. If `XDG_CONFIG_HOME` is set, its `cchop` directory is used instead. `init` prints their locations and refuses to overwrite existing files.

Log in to your subscription using the remote Claude Code installation, with relay overrides removed from that shell:

```bash
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY -u ANTHROPIC_CUSTOM_HEADERS claude auth login
```

The [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) documents this login command. cchop expects `~/.claude/.credentials.json`, containing `claudeAiOauth.accessToken`, `refreshToken`, and millisecond `expiresAt`. For a different location, use `cchop init --credentials /absolute/path/to/.credentials.json`, or configure the path afterwards. In particular, point cchop explicitly at the matching file if Claude Code uses `CLAUDE_CONFIG_DIR`; see [Claude credential storage](https://code.claude.com/docs/en/authentication#credential-management).

Keep any recovery backup private and outside the project. A backup containing an already-rotated refresh token may no longer authenticate; a fresh remote login is the recovery path when credentials cannot be refreshed.

## Capture once

With the relay stopped, run:

```bash
cchop capture
```

This listens only on `127.0.0.1:9999` and prints a command to run in a second terminal on the **same relay host**:

```bash
env -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY -u ANTHROPIC_CUSTOM_HEADERS ANTHROPIC_BASE_URL=http://127.0.0.1:9999 claude
```

Send a short message. Capture records the first valid `/v1/messages` request's reusable headers, complete `metadata.user_id`, timestamp, and capture process Node version. It excludes authorization, cookies, transport headers, and the prompt body. The original request is forwarded upstream with its original OAuth authorization and its response streams back unchanged. Capture exits after that exchange. An upstream failure is reported even if the fingerprint was saved.

Exit the remote Claude Code session before starting the relay. Once the relay is running, it must be the only process refreshing that credential file. Use one person, one subscription, and one relay instance, as prescribed by the document.

After upgrading the remote Claude Code installation, stop the relay and repeat `cchop capture --replace`. Replacement is atomic. Capture never overwrites an existing fingerprint unless `--replace` is given. Align the relay's Node major version with capture; startup and diagnostics warn when they differ. This version check does not establish TLS fingerprint equivalence.

## Start and connect

On the relay host, check the captured identity and credentials, then generate local client settings:

```bash
cchop doctor --offline
cchop client --url https://cchop.example.com --output ./claude.settings.json
cchop start
```

The relay defaults to `127.0.0.1:8787`. Use `cchop start --host 0.0.0.0` to bind all IPv4 interfaces. The dashboard defaults to `http://127.0.0.1:8788`; sign in with `CCHOP_ADMIN_TOKEN` from the private `credentials.env` file. The CLI prints the file path, never either key.

Privately copy the generated settings to the **local client machine**, then run:

```bash
claude --settings ./claude.settings.json
```

The file sets exactly `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`. The latter is the cchop shared key, not an Anthropic token. No local subscription login is used for relay requests. The remote OAuth tokens are never included. For a same-host check, generate settings with `--url http://127.0.0.1:8787`.

The settings file is owner-only and is never silently overwritten. Existing Claude settings are not edited. Remove conflicting API-key, custom-header, or alternate-provider overrides from your client setup. A base URL controls supported API requests; login and auxiliary network endpoints may be separate.

`cchop start` stays in the foreground. Ctrl+C or SIGTERM stops accepting work, drains active requests until the configured deadline, cancels remaining network work, and closes both listeners. An already-received token rotation finishes its atomic credential commit before exit. Run configuration commands in another terminal while it is active.

## Request mechanism

```mermaid
flowchart LR
    Client[Local Claude Code] -->|Request + relay bearer key| Auth[Verify relay key]
    Auth -->|Accepted request| Rewrite[Replace captured headers<br/>and metadata.user_id]
    Capture[Remote capture] -->|Fingerprint| Rewrite
    Credentials[Remote credential file] -->|Current OAuth token| Rewrite
    Rewrite -->|Rewritten request + OAuth| API[Anthropic API]
    API -->|Streaming response| Client
```

1. Compare the incoming bearer key using SHA-256 and constant-time comparison. Reject invalid or duplicate authentication headers before reading credentials or contacting the provider.
2. Strip local `user-agent`, `x-app`, `anthropic-version`, `anthropic-beta`, `sec-fetch-mode`, all `x-stainless-*`, provider credentials, gateway headers, and hop-by-hop/forwarding headers. Apply the captured reusable headers.
3. Replace `metadata.user_id` with the captured complete value when a metadata object exists. Preserve other JSON fields. Invalid JSON, invalid metadata, and compressed request bodies are rejected; content length is recalculated from the rewritten bytes.
4. Read the remote credential file for every request. Within five minutes of expiry, refresh through the configured token endpoint. One in-process promise serializes refreshes. Persist both newly returned tokens and expiry through an owner-only temporary file and atomic rename, preserving other credential metadata. A failed refresh or persistence returns **503**, without forwarding an inference request or returning an unpersisted access token.
5. Send the rewritten request with the remote OAuth bearer token using Node.js and undici. Stream the response with backpressure. Client disconnection cancels upstream work. Inference requests are never automatically retried; redirects are rejected.

This deliberately follows the document's captured headers and fixed captured session identity, including its trade-off: changes in the local client's capability headers are not merged into the recorded fingerprint. Re-capture after remote client upgrades. cchop does not claim that rewriting identity prevents account enforcement or proves equivalence with the remote client's TLS handshake.

## Commands

| Command | Purpose |
| --- | --- |
| `cchop init` | Create configuration and relay/admin keys |
| `cchop capture [--port 9999] [--replace]` | Capture one remote request on loopback |
| `cchop start` | Start subscription relay and dashboard |
| `cchop doctor [--offline] [--json]` | Inspect configuration, fingerprint, runtime, credentials, and optional connectivity; never refresh tokens or send inference |
| `cchop client --url <origin> --output <file>` | Generate private local client settings |
| `cchop --config <path> <command>` | Select a different configuration file |

`start` accepts listener overrides `--host`, `--port`, `--admin-host`, and `--admin-port`. `--quiet` disables per-request metadata logs; sanitized fingerprint/runtime/refresh diagnostics remain available. Use each command's `--help` for its options.

## Configuration and secrets

`CCHOP_CONFIG` or `--config` selects the configuration file. cchop reads `credentials.env` beside it; process environment variables take precedence. It does not load arbitrary working-directory `.env` files. Relative fingerprint and Claude credential paths resolve against the configuration directory.

| Variable | Meaning |
| --- | --- |
| `CCHOP_GATEWAY_TOKEN` | Shared relay bearer key, 24–256 characters |
| `CCHOP_ADMIN_TOKEN` | Independent dashboard key, 24–256 characters |
| `CCHOP_CONFIG` | Configuration path |
| `CCHOP_FINGERPRINT` | Captured fingerprint path |
| `CCHOP_CLAUDE_CREDENTIALS` | Remote Claude OAuth credential JSON path |
| `CCHOP_HOST`, `CCHOP_PORT` | Relay listener overrides |
| `CCHOP_ADMIN_HOST`, `CCHOP_ADMIN_PORT` | Administration listener overrides |
| `CCHOP_UPSTREAM` | Upstream API origin |
| `CCHOP_PUBLIC_URL` | Relay origin for generated settings |
| `CCHOP_OAUTH_TOKEN_URL`, `CCHOP_OAUTH_CLIENT_ID` | Public OAuth application settings; defaults follow the source document |

See [.env.example](.env.example). OAuth access and refresh tokens are read from the configured Claude credential file, not cchop environment variables.

| JSON field | Default | Purpose |
| --- | --- | --- |
| `host` / `port` | `127.0.0.1` / `8787` | Relay listener |
| `adminHost` / `adminPort` | `127.0.0.1` / `8788` | Separate dashboard listener |
| `upstream` | `https://api.anthropic.com` | API destination |
| `publicUrl` | `null` | Optional public relay origin |
| `authMode` | `subscription` | Document's remote subscription design |
| `fingerprintPath` | `fingerprint.json` | Relative to configuration directory |
| `claudeCredentialsPath` | `~/.claude/.credentials.json` as an absolute path | Remote credential file |
| `oauthTokenUrl` | `https://platform.claude.com/v1/oauth/token` | Token refresh endpoint from the document |
| `oauthClientId` | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` | Public OAuth client ID from the document |
| `maxRequestBytes` | `33554432` | Body bound before and after rewriting |
| `maxConcurrent` | `32` | Concurrent authenticated relay requests |
| `headersTimeoutMs` | `60000` | Upstream header timeout |
| `streamIdleTimeoutMs` | `360000` | Maximum silence between upstream response chunks |
| `shutdownGraceMs` | `30000` | Maximum drain time |
| `recentRequestsLimit` | `100` | Retained request metadata per process |

External API origins and OAuth endpoints require HTTPS. HTTP is allowed only for loopback tests. Relay and admin ports/keys must differ. Fingerprint, configuration, gateway credentials, and Claude credentials must use distinct paths. Restart after rotating relay/admin keys or replacing a fingerprint. OAuth credentials are reread automatically.

## Migrating the earlier proxy build

The previous `passthrough` and `api-key` behaviors have been removed. Existing configurations with those modes fail with a migration message; cchop does not silently change their authentication. Stop that process, set `authMode` to `subscription`, configure the remote credential and fingerprint paths, perform capture, and regenerate client settings at a new path. Remove the old `X-Cchop-Key` custom-header configuration. Existing relay/admin keys may be retained.

## Development and verification

```bash
npm ci
npm run check
npm run test:package
npx playwright install chromium
npm run test:browser
```

`npm run check` runs ESLint, server/UI type checks, both builds, and protocol/CLI tests. `npm run test:package` installs the tarball globally into a temporary prefix and exercises the actual installed capture, startup, client, dashboard, streaming, and shutdown flow. It leaves the current tarball in this checkout and removes its temporary installation. Browser checks cover real local service metrics, authentication, polling, filtering, offline behavior, and desktop/mobile layout. An existing Chromium can be selected with `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

All automated checks use temporary fake fingerprints, generated test credentials, and loopback API/OAuth servers. They do not read the operator's credential store or make real subscription requests. Successful mock checks establish implementation behavior; live remote login, capture, and provider compatibility still require operator validation. Tests supervise and close their temporary services in the foreground. CI runs lint, types, tests, builds, package checks, and browser checks.

For dashboard development, first build and start cchop, then run `npm run dev --workspace @cchop/web` in another terminal. Vite forwards `/api` to the default local admin port.

## Releasing

Keep the version in the root and web package manifests, lockfile, `src/config.ts`, and the installed-version assertion in `scripts/package-smoke.ts` aligned. Update versioned installation examples when releasing a new version.

### GitHub Actions publishing

The [Publish to npm workflow](.github/workflows/publish.yml) runs when a stable GitHub release is published. It checks out that release's tag, checks that `v<version>` matches the package and CLI versions, runs lint, types, builds, protocol/CLI tests, and package/browser smoke checks, then publishes the tested tarball with provenance. It verifies that npm serves the same artifact. Prereleases are skipped. Concurrent publishing runs are serialized.

Configure the package's [npm trusted publisher](https://docs.npmjs.com/trusted-publishers/) once in [npm package settings](https://www.npmjs.com/package/cchop/access):

| Setting | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `kr4t0n` |
| Repository | `cchop` |
| Workflow filename | `publish.yml` |
| Environment | Leave empty |
| Allowed actions | Enable direct publishing with `npm publish` |

The workflow uses GitHub-hosted runners and OIDC authentication. No `NPM_TOKEN` GitHub secret is needed. The pinned npm CLI supports trusted publishing. With npm 11.15 or newer, the same trust connection can be configured using `npm trust github cchop --repo kr4t0n/cchop --file publish.yml --allow-publish --yes`; npm may require browser verification.

For each release, commit and push the version changes, wait for CI, create and push a `v<version>` tag on that commit, then publish its GitHub release. Publishing the GitHub release authorizes npm publication. Inspect the workflow result before announcing availability. Each release needs a new npm version; the published `0.1.0` cannot be reused. A failed workflow can be rerun after correcting authentication, provided its version has not already been published.

Use **Actions → Publish to npm → Run workflow** to validate the selected ref without publishing. Manual runs execute all checks and a publish dry run; they do not exercise npm's OIDC publication authorization. Pushing a commit or tag alone does not publish a package.

### Manual publishing fallback

Run `npm run check`, `npm run test:package`, and `npm run test:browser`. The package smoke check creates and tests the release tarball. Inspect it with `npm publish ./cchop-<version>.tgz --dry-run`, commit the release changes, and publish that same tarball with `npm publish ./cchop-<version>.tgz --access public` from an authenticated npm account. Replace `<version>` with the release version. Verify the registry integrity and install the published version in a temporary prefix before announcing it. Publishing a GitHub release afterwards also triggers the workflow, which will fail when attempting to republish that existing version; prefer the automated path for normal releases.

## Project structure

| Path | Responsibility |
| --- | --- |
| `src/cli.ts`, `src/config.ts`, `src/doctor.ts` | Commands, configuration, diagnostics |
| `src/capture.ts`, `src/fingerprint.ts` | Loopback capture and private fingerprint persistence |
| `src/rewriter.ts` | Captured identity substitution |
| `src/credentials.ts` | Disk-backed OAuth credentials, serialized refresh, atomic rotation |
| `src/server.ts`, `src/security.ts` | Relay transport, listener isolation, authentication, header filtering |
| `src/metrics.ts`, `src/types.ts` | Bounded operational history and dashboard contract |
| `web/` | React/TypeScript/Tailwind operations dashboard |
| `test/`, `scripts/` | Protocol/CLI tests and package/browser smoke checks |
| `.github/workflows/ci.yml` | Application verification |
| `.github/workflows/publish.yml` | Stable-release npm publishing and manual validation |

The relay serves messages, token counting, models, and the connection-warming probe. Logs contain request metadata and sanitized capture/refresh diagnostics, never prompts, OAuth tokens, gateway keys, or `metadata.user_id`. Request history is bounded and in memory; restarting clears it. Dashboard credentials stay only in browser memory. No account pooling, credential sharing service, deployment manifests, or container packaging are included.
