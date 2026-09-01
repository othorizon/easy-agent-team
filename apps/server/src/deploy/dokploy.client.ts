/**
 * Dokploy API 客户端（挂载式：平台不自建部署系统）。
 * 端点基于 Dokploy REST API（x-api-key 认证）：
 *   POST {apiUrl}/application.deploy   { applicationId }
 *   GET  {apiUrl}/application.one?applicationId=...  → { applicationStatus }
 *   GET  {apiUrl}/project.all          （只读；连通性测试与应用清单都用它）
 * 真实联调时如有出入，仅需在本文件校准。
 */
import type { DokployApplication } from '@eat/shared';

/**
 * project.all 的响应形状（只取用得上的字段，其余忽略；真实响应还含 db/compose 等其他服务）。
 * 注意 Dokploy 引入「环境」后，applications 从项目下挪到了 environments[] 下——
 * 两种形状都要认（见 listApplications）。
 */
interface DokployProjectRow {
  name?: unknown;
  applications?: unknown;
  environments?: unknown;
}

interface DokployEnvironmentRow {
  name?: unknown;
  isDefault?: unknown;
  applications?: unknown;
}

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

  /** 连通性测试：调用只读端点验证地址与 token，失败抛错（含 HTTP 状态） */
  async testConnection(): Promise<void> {
    const res = await fetch(`${this.base}/project.all`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`Dokploy 返回 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }

  /**
   * 拉取 Dokploy 上的应用清单（决策 27）：project.all 一次就带回各项目及其 applications，
   * 不必按项目逐个再查。响应里还有 db / compose 等其他服务，这里只取 applications。
   *
   * 应用挂在哪一层取决于 Dokploy 版本：老版本直接挂在项目下（`project.applications`），
   * 引入「环境」之后挂在 `project.environments[].applications`。两种都认，否则新版本上清单恒为空。
   * 非默认环境的应用在分组名上带出环境名（`项目 · 环境`），免得同名应用分不清是哪套环境。
   *
   * 防御式解析：形状对不上的条目直接跳过，不让一个异常条目毁掉整张清单。
   */
  async listApplications(): Promise<DokployApplication[]> {
    const res = await fetch(`${this.base}/project.all`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`Dokploy 返回 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const json: unknown = await res.json();
    if (!Array.isArray(json)) return [];
    const apps: DokployApplication[] = [];
    const collect = (list: unknown, projectName: string): void => {
      if (!Array.isArray(list)) return;
      for (const raw of list as Array<Record<string, unknown>>) {
        const applicationId = raw?.applicationId;
        if (typeof applicationId !== 'string' || applicationId === '') continue;
        apps.push({
          applicationId,
          name: typeof raw.name === 'string' ? raw.name : applicationId,
          appName: typeof raw.appName === 'string' ? raw.appName : '',
          projectName,
          description: typeof raw.description === 'string' ? raw.description : '',
        });
      }
    };
    for (const project of json as DokployProjectRow[]) {
      const projectName = typeof project?.name === 'string' ? project.name : '';
      collect(project?.applications, projectName);
      if (Array.isArray(project?.environments)) {
        for (const env of project.environments as DokployEnvironmentRow[]) {
          const envName = typeof env?.name === 'string' ? env.name : '';
          const label = env?.isDefault === true || envName === '' ? projectName : `${projectName} · ${envName}`;
          collect(env?.applications, label);
        }
      }
    }
    return apps;
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
