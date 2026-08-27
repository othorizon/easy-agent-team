/**
 * Dokploy API 客户端（挂载式：平台不自建部署系统）。
 * 端点基于 Dokploy REST API（x-api-key 认证）：
 *   POST {apiUrl}/application.deploy   { applicationId }
 *   GET  {apiUrl}/application.one?applicationId=...  → { applicationStatus }
 * 真实联调时如有出入，仅需在本文件校准。
 */
export interface DokployConn {
  apiUrl: string;
  apiToken: string;
}

export type DokployAppStatus = 'idle' | 'running' | 'done' | 'error' | 'unknown';

export class DokployClient {
  constructor(private readonly conn: DokployConn) {}

  private get base(): string {
    return this.conn.apiUrl.replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', 'x-api-key': this.conn.apiToken };
  }

  async deploy(applicationId: string): Promise<void> {
    const res = await fetch(`${this.base}/application.deploy`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ applicationId }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`Dokploy 部署触发失败（HTTP ${res.status}）: ${(await res.text()).slice(0, 300)}`);
    }
  }

  async applicationStatus(applicationId: string): Promise<DokployAppStatus> {
    const res = await fetch(`${this.base}/application.one?applicationId=${encodeURIComponent(applicationId)}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return 'unknown';
    const json = (await res.json()) as { applicationStatus?: string };
    const status = json.applicationStatus;
    return status === 'idle' || status === 'running' || status === 'done' || status === 'error' ? status : 'unknown';
  }
}
