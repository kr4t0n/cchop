export type AuthMode = 'subscription';

export interface RequestRecord {
  id: string;
  method: string;
  path: string;
  status: number;
  outcome: 'ok' | 'upstream_error' | 'cancelled' | 'relay_error';
  startedAt: string;
  durationMs: number;
  bytesIn: number;
  bytesOut: number;
}

export interface StatusSnapshot {
  version: string;
  startedAt: string;
  uptimeSeconds: number;
  state: 'ready' | 'draining';
  relay: {
    host: string;
    port: number;
    upstream: string;
    authMode: AuthMode;
    activeRequests: number;
    maxConcurrent: number;
    publicUrl: string | null;
  };
  totals: {
    requests: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    bytesReceived: number;
    bytesSent: number;
  };
  latency: {
    averageMs: number | null;
    p95Ms: number | null;
    lastMs: number | null;
  };
  recentRequests: RequestRecord[];
  runtime: { nodeVersion: string; platform: string; arch: string };
}
