export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export type ProbeStatus = 'responsive' | 'timeout' | 'error' | 'ws-error' | 'closed' | 'no-websocket';

export interface ProbeResult {
  id: string;
  type: string;
  title: string;
  url: string;
  printPreview: boolean;
  status: ProbeStatus;
  ms: number;
  error?: string;
}

/** Endpoint defaults to $CDP_ENDPOINT, then http://127.0.0.1:9222. */
export function listTargets(endpoint?: string, opts?: { timeout?: number }): Promise<CdpTarget[]>;
export function probeTarget(target: CdpTarget, opts?: { timeout?: number }): Promise<{ status: ProbeStatus; ms: number; error?: string }>;
export function probeTargets(endpoint?: string, opts?: { timeout?: number; types?: string[] }): Promise<ProbeResult[]>;
/** Resolves true once the target is gone from /json/list. */
export function closeTarget(endpoint: string | undefined, id: string, opts?: { timeout?: number }): Promise<boolean>;
