import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';

export const VERSION = '0.1.0';

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return (url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
      && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
  } catch {
    return false;
  }
}

function isTokenEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return isOrigin(url.origin) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

const bindAddress = z.string().refine((value) => value === 'localhost' || isIP(value) !== 0,
  'Use an IP address or localhost');

export const configSchema = z.object({
  host: bindAddress.default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8787),
  adminHost: bindAddress.default('127.0.0.1'),
  adminPort: z.number().int().min(1).max(65535).default(8788),
  upstream: z.string().refine(isOrigin, 'Use an HTTPS origin without a path, credentials, or query; HTTP is allowed only for loopback testing').default('https://api.anthropic.com'),
  publicUrl: z.string().refine(isOrigin, 'Use an HTTPS origin (HTTP is allowed only for localhost)').nullable().default(null),
  authMode: z.literal('subscription').default('subscription'),
  fingerprintPath: z.string().min(1).default('fingerprint.json'),
  claudeCredentialsPath: z.string().min(1).default(join(homedir(), '.claude', '.credentials.json')),
  oauthTokenUrl: z.string().refine(isTokenEndpoint, 'Use an HTTPS token endpoint; HTTP is allowed only for loopback testing').default('https://platform.claude.com/v1/oauth/token'),
  oauthClientId: z.string().min(1).max(256).regex(/^[\w-]+$/).default('9d1c250a-e61b-44d9-88ed-5944d1962f5e'),
  maxRequestBytes: z.number().int().min(1024).max(128 * 1024 * 1024).default(32 * 1024 * 1024),
  maxConcurrent: z.number().int().min(1).max(1024).default(32),
  headersTimeoutMs: z.number().int().min(1000).max(600000).default(60000),
  streamIdleTimeoutMs: z.number().int().min(1000).max(3600000).default(360000),
  shutdownGraceMs: z.number().int().min(1).max(3600000).default(30000),
  recentRequestsLimit: z.number().int().min(1).max(1000).default(100),
}).strict().refine((value) => value.port !== value.adminPort, {
  message: 'Relay and administration ports must be different', path: ['adminPort'],
});

export type Configuration = z.infer<typeof configSchema>;
export interface RuntimeConfig extends Configuration {
  configPath: string;
  gatewayToken: string;
  adminToken: string;
}

export class ConfigurationError extends Error {}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.CCHOP_CONFIG ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'cchop', 'cchop.json'));
}

export function credentialsPath(configPath: string): string {
  return join(dirname(resolve(configPath)), 'credentials.env');
}

export async function initConfiguration(configPath: string, values: Record<string, unknown> = {}): Promise<void> {
  const parsed = configSchema.safeParse(values);
  if (!parsed.success) throw new ConfigurationError(formatIssues(parsed.error));
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  for (const path of [configPath, credentialsPath(configPath)]) {
    try {
      await readFile(path);
      throw new ConfigurationError(`Configuration already exists at ${path}. Edit it to change settings; existing secrets were preserved.`);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  const secrets = [
    '# Private cchop credentials. Keep this file outside version control.',
    `CCHOP_GATEWAY_TOKEN=${randomBytes(32).toString('base64url')}`,
    `CCHOP_ADMIN_TOKEN=${randomBytes(32).toString('base64url')}`,
    '',
  ].join('\n');
  await writeFile(credentialsPath(configPath), secrets, { flag: 'wx', mode: 0o600 });
  await writeFile(configPath, `${JSON.stringify(parsed.data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || 'configuration'}: ${issue.message}`).join('\n');
}

export async function loadConfiguration(configPath: string, env: NodeJS.ProcessEnv = process.env): Promise<RuntimeConfig> {
  const absolutePath = resolve(configPath);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(absolutePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new ConfigurationError('Configuration must contain valid JSON.');
    throw new ConfigurationError(`Cannot read ${absolutePath}. Run cchop init --config <path> first, or select an existing configuration file.`);
  }
  let fileEnv: Record<string, string | undefined> = {};
  try {
    fileEnv = parseEnv(await readFile(credentialsPath(absolutePath), 'utf8'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw new ConfigurationError('Cannot read the credentials file. Check its permissions.');
    }
  }
  const variables = { ...fileEnv, ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigurationError('Configuration must be a JSON object.');
  if ('authMode' in raw && raw.authMode !== 'subscription') {
    throw new ConfigurationError('This configuration uses the previous proxy design. Set authMode to subscription, configure the remote Claude credentials path, and run cchop capture before starting.');
  }
  const overrides: Record<string, unknown> = {};
  const envKeys = {
    CCHOP_HOST: 'host', CCHOP_PORT: 'port', CCHOP_ADMIN_HOST: 'adminHost',
    CCHOP_ADMIN_PORT: 'adminPort', CCHOP_UPSTREAM: 'upstream',
    CCHOP_AUTH_MODE: 'authMode', CCHOP_PUBLIC_URL: 'publicUrl',
    CCHOP_FINGERPRINT: 'fingerprintPath', CCHOP_CLAUDE_CREDENTIALS: 'claudeCredentialsPath',
    CCHOP_OAUTH_TOKEN_URL: 'oauthTokenUrl', CCHOP_OAUTH_CLIENT_ID: 'oauthClientId',
  } as const;
  for (const [key, field] of Object.entries(envKeys)) {
    if (variables[key] !== undefined) {
      overrides[field] = field === 'port' || field === 'adminPort' ? Number(variables[key]) : variables[key];
    }
  }
  const parsed = configSchema.safeParse({ ...raw, ...overrides });
  if (!parsed.success) throw new ConfigurationError(formatIssues(parsed.error));
  const gatewayToken = variables.CCHOP_GATEWAY_TOKEN;
  const adminToken = variables.CCHOP_ADMIN_TOKEN;
  for (const [name, token] of [['CCHOP_GATEWAY_TOKEN', gatewayToken], ['CCHOP_ADMIN_TOKEN', adminToken]]) {
    if (!token || token.length < 24 || token.length > 256 || /[\s\x00-\x1f\x7f]/.test(token)) {
      throw new ConfigurationError(`${name} must be a 24–256 character secret without whitespace. Run cchop init or configure your environment.`);
    }
  }
  if (gatewayToken === adminToken) throw new ConfigurationError('Relay and administration credentials must be different.');
  const fingerprintPath = resolve(dirname(absolutePath), parsed.data.fingerprintPath);
  const claudeCredentialsPath = resolve(dirname(absolutePath), parsed.data.claudeCredentialsPath);
  if (new Set([absolutePath, credentialsPath(absolutePath), fingerprintPath, claudeCredentialsPath]).size !== 4) {
    throw new ConfigurationError('Configuration, gateway credentials, fingerprint, and Claude credentials must use separate files.');
  }
  return { ...parsed.data, fingerprintPath, claudeCredentialsPath, configPath: absolutePath, gatewayToken: gatewayToken!, adminToken: adminToken! };
}

export function localUrl(host: string, port: number): string {
  const connectHost = ['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host;
  return `http://${isIP(connectHost) === 6 ? `[${connectHost}]` : connectHost}:${port}`;
}
