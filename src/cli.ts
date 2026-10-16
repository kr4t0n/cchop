#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { Command } from 'commander';
import { configSchema, credentialsPath, defaultConfigPath, initConfiguration, loadConfiguration, localUrl, VERSION } from './config.js';
import { runDoctor } from './doctor.js';
import { startCapture } from './capture.js';
import { startApplication } from './server.js';

const program = new Command()
  .name('cchop')
  .description('A self-hosted Claude Code relay. One command starts the relay and dashboard.')
  .version(VERSION)
  .option('-c, --config <path>', 'configuration file', defaultConfigPath())
  .showHelpAfterError();

function configPath(): string { return resolve(program.opts<{ config: string }>().config); }

program.command('init')
  .description('Create configuration and private credentials; preserve existing files')
  .option('--host <address>', 'relay bind address', '127.0.0.1')
  .option('--port <number>', 'relay port', '8787')
  .option('--admin-port <number>', 'dashboard port', '8788')
  .option('--credentials <path>', 'remote Claude OAuth credentials JSON file')
  .option('--fingerprint <path>', 'captured fingerprint file; relative to configuration directory')
  .option('--public-url <url>', 'public HTTPS origin for the relay')
  .action(async (options: { host: string; port: string; adminPort: string; credentials?: string; fingerprint?: string; publicUrl?: string }) => {
    await initConfiguration(configPath(), {
      host: options.host, port: Number(options.port), adminPort: Number(options.adminPort),
      claudeCredentialsPath: options.credentials, fingerprintPath: options.fingerprint, publicUrl: options.publicUrl ?? null,
    });
    process.stdout.write(`Created ${configPath()}\nPrivate relay credentials: ${credentialsPath(configPath())}\n\nNext on the relay host: log in to the remote Claude Code client, then run cchop capture.\nAfter capture: cchop doctor --offline, then cchop start.\nUse cchop client --url https://cchop.example.com to create local client settings.\n`);
  });

program.command('capture')
  .description('Capture one remote Claude Code request on loopback, then exit')
  .option('--port <number>', 'loopback capture port', '9999')
  .option('--replace', 'atomically replace an existing fingerprint after stopping the relay')
  .action(async (options: { port: string; replace?: boolean }) => {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Capture port must be between 1 and 65535.');
    const config = await loadConfiguration(configPath());
    let captured = false;
    const capture = await startCapture(config, { port, replace: options.replace, onCaptured: () => { captured = true; } });
    const stop = () => { void capture.close(); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
      process.stdout.write(`Capture listening: http://127.0.0.1:${capture.port}\nIn another terminal on this relay host, use the logged-in remote Claude Code client:\n\n  env -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY -u ANTHROPIC_CUSTOM_HEADERS ANTHROPIC_BASE_URL=http://127.0.0.1:${capture.port} claude\n\nSend a short message, then exit that Claude Code session. cchop saves reusable headers and the device_id/account_uuid from metadata.user_id; credentials, prompts, session IDs, and per-request headers are excluded.\n`);
      await capture.completed;
      if (captured) {
        process.stdout.write(`Captured remote fingerprint: ${config.fingerprintPath}\nStop the remote Claude Code client before cchop start; only the relay should refresh its credentials.\n`);
        if (capture.exchange?.error || (capture.exchange?.upstreamStatus ?? 0) >= 400) {
          process.stderr.write('The fingerprint was saved, but its upstream exchange failed. Check the remote login and upstream before starting.\n');
          process.exitCode = 1;
        }
      } else process.stdout.write('Capture stopped without saving a fingerprint.\n');
    } finally {
      await capture.close();
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  });

program.command('start')
  .description('Start the relay and bundled dashboard in the foreground')
  .option('--host <address>', 'override relay bind address')
  .option('--port <number>', 'override relay port')
  .option('--admin-host <address>', 'override dashboard bind address')
  .option('--admin-port <number>', 'override dashboard port')
  .option('--quiet', 'disable request metadata logs')
  .action(async (options: { host?: string; port?: string; adminHost?: string; adminPort?: string; quiet?: boolean }) => {
    const env = { ...process.env };
    if (options.host !== undefined) env.CCHOP_HOST = options.host;
    if (options.port !== undefined) env.CCHOP_PORT = options.port;
    if (options.adminHost !== undefined) env.CCHOP_ADMIN_HOST = options.adminHost;
    if (options.adminPort !== undefined) env.CCHOP_ADMIN_PORT = options.adminPort;
    const config = await loadConfiguration(configPath(), env);
    const app = await startApplication(config, {
      log: options.quiet ? undefined : (record) => { process.stdout.write(`${JSON.stringify({ event: 'request', ...record })}\n`); },
      event: (record) => { process.stderr.write(`${JSON.stringify(record)}\n`); },
    });
    process.stdout.write(`cchop ${VERSION}\nRelay: ${localUrl(config.host, app.relayPort)} (bind ${config.host})\nDashboard: ${localUrl(config.adminHost, app.adminPort)} (bind ${config.adminHost})\nAuthentication: ${config.authMode}\nDashboard sign-in: CCHOP_ADMIN_TOKEN from your environment or ${credentialsPath(configPath())}\nPress Ctrl+C to drain requests and stop.\n`);
    await new Promise<void>((resolveStop) => {
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        process.stdout.write('Draining active requests…\n');
        void app.close().then(() => {
          process.stdout.write('cchop stopped.\n');
        }).catch(() => {
          process.stderr.write('cchop could not finish graceful shutdown.\n');
          process.exitCode = 1;
        }).finally(() => {
          process.off('SIGINT', stop);
          process.off('SIGTERM', stop);
          resolveStop();
        });
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
  });

program.command('doctor')
  .description('Check configuration, assets, and connectivity without an inference request')
  .option('--offline', 'skip all network checks')
  .option('--json', 'output structured diagnostics')
  .action(async (options: { offline?: boolean; json?: boolean }) => {
    const config = await loadConfiguration(configPath());
    const checks = await runDoctor(config, options.offline ?? false);
    if (options.json) process.stdout.write(`${JSON.stringify({ checks }, null, 2)}\n`);
    else for (const check of checks) process.stdout.write(`${check.status.toUpperCase().padEnd(5)} ${check.name}: ${check.message}\n`);
    if (checks.some((check) => check.status === 'error')) process.exitCode = 1;
  });

program.command('client')
  .description('Write a private Claude Code settings file without editing existing Claude settings')
  .option('--url <url>', 'public HTTPS origin for the relay or a loopback origin')
  .option('--output <path>', 'output file (must not already exist)')
  .action(async (options: { url?: string; output?: string }) => {
    const config = await loadConfiguration(configPath());
    const url = options.url ?? config.publicUrl ?? localUrl(config.host, config.port);
    const parsed = configSchema.safeParse({ publicUrl: url });
    if (!parsed.success) throw new Error('Client URL must be an HTTPS origin; HTTP is allowed only for loopback.');
    const outputPath = resolve(options.output ?? join(dirname(configPath()), 'claude.settings.json'));
    const env: Record<string, string> = { ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: config.gatewayToken };
    await writeFile(outputPath, `${JSON.stringify({ env }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`Created private client settings: ${outputPath}\nStart Claude Code with --settings pointing to this file.\nThis file contains the relay access key. Transfer it privately if the client runs on another machine.\n`);
  });

try {
  if (process.argv.length === 2) program.help();
  await program.parseAsync(process.argv);
} catch (error) {
  let message = error instanceof Error ? error.message : 'Unexpected failure.';
  if (error instanceof Error && 'code' in error && error.code === 'EEXIST') message = 'The output file already exists. Choose a new path; existing files were preserved.';
  if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') message = 'A configured port is already in use. Stop the existing process or choose different ports.';
  process.stderr.write(`cchop: ${message}\n`);
  process.exitCode = 1;
}
