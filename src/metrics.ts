import { VERSION, type RuntimeConfig } from './config.js';
import type { RequestRecord, StatusSnapshot } from './types.js';

export class Metrics {
  readonly startedAt = new Date();
  active = 0;
  draining = false;
  readonly totals = { requests: 0, succeeded: 0, failed: 0, cancelled: 0, bytesReceived: 0, bytesSent: 0 };
  private records: RequestRecord[] = [];

  constructor(private readonly limit: number) {}

  record(item: RequestRecord): void {
    this.totals.requests += 1;
    if (item.outcome === 'ok') this.totals.succeeded += 1;
    else if (item.outcome === 'cancelled') this.totals.cancelled += 1;
    else this.totals.failed += 1;
    this.totals.bytesReceived += item.bytesIn;
    this.totals.bytesSent += item.bytesOut;
    this.records.unshift(item);
    this.records = this.records.slice(0, this.limit);
  }

  snapshot(config: RuntimeConfig, relayPort: number): StatusSnapshot {
    const durations = this.records.map((record) => record.durationMs).sort((a, b) => a - b);
    return {
      version: VERSION,
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
      state: this.draining ? 'draining' : 'ready',
      relay: {
        host: config.host, port: relayPort, upstream: config.upstream,
        authMode: config.authMode, activeRequests: this.active,
        maxConcurrent: config.maxConcurrent, publicUrl: config.publicUrl,
      },
      totals: { ...this.totals },
      latency: {
        averageMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
        p95Ms: durations[Math.ceil(durations.length * 0.95) - 1] ?? null,
        lastMs: this.records[0]?.durationMs ?? null,
      },
      recentRequests: [...this.records],
      runtime: { nodeVersion: process.version, platform: process.platform, arch: process.arch },
    };
  }
}
