/**
 * Dokploy API 客户端（挂载式：平台不自建部署系统）。
 * 端点基于 Dokploy REST API（x-api-key 认证）：
 *   POST {apiUrl}/application.deploy   { applicationId, title?, description? }（决策 30）
 *   GET  {apiUrl}/application.one?applicationId=...  → { appName }（找容器用）
 *   GET  {apiUrl}/project.all          （只读；连通性测试与应用清单都用它）
 *   GET  {apiUrl}/deployment.allByType?id=...&type=application  → 构建记录列表（每应用最多 10 条，见下）
 *   GET  {apiUrl}/deployment.queueList → 部署队列里的任务（构建记录还没建出来时的唯一去处，决策 30）
 *   GET  {apiUrl}/deployment.readLogs?deploymentId=...&tail=N   → 构建日志正文（决策 28）
 *   GET  {apiUrl}/docker.getContainersByAppNameMatch?appName=... → 应用的容器
 *   WS   {wsBase}/docker-container-logs?containerId=...          → 运行日志（决策 28）
 * 真实联调时如有出入，仅需在本文件校准。
 *
 * 两条来自 Dokploy 源码（对 v0.30.4 逐处核对）的硬约束，决定了平台侧的做法（决策 30）：
 *   1. deploy 的 title / description 会被原样写进构建记录并持久化，**但 v0.25.0 才加**；
 *      更早的版本 zod 会把这两个键静默丢掉（不报错），此时只能回落到按时间推断认领。
 *   2. Dokploy 每建一条构建记录就调 removeLastTenDeployments，**每个应用只保留最近 10 条**，
 *      超出的连日志文件一起删；硬编码不可配。所以部署历史的长期留存只能靠平台侧元数据。
 */
import type { DokployApplication, DokployContainer, DokployDeployment } from '@eat/shared';
import { WebSocket } from 'ws';

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

/** Dokploy 部署队列里的一个任务（deployment.queueList 的一行，只取用得上的字段） */
export interface DokployQueueJob {
  applicationId: string;
  title: string;
  description: string;
  /** BullMQ 的任务状态：waiting / delayed / active / completed / failed / paused */
  state: string;
  /** 入队时间（毫秒） */
  timestamp: number;
}

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

  /**
   * 触发部署。tag 会写进构建记录的 title / description 并被 Dokploy 持久化（决策 30）：
   * 平台靠 description 里的标记精确认领「这条构建记录是哪次平台部署」，不必再按时间猜。
   * 注意响应体是空的——Dokploy 只把任务塞进队列，构建记录要等队列执行时才建出来。
   */
  async deploy(applicationId: string, tag?: { title: string; description: string }): Promise<void> {
    const res = await fetch(`${this.base}/application.deploy`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ applicationId, ...(tag ?? {}) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`Dokploy 部署触发失败（HTTP ${res.status}）: ${(await res.text()).slice(0, 300)}`);
    }
  }

  // ---------- 构建日志 / 运行日志（决策 28） ----------

  /**
   * 某应用的构建记录列表（最新在前）。Dokploy 的一次「构建」= 一条 deployment 记录，
   * 它比 application.applicationStatus 精确：后者是应用当前状态，同一应用被别人再次部署就会被覆盖。
   */
  async listDeployments(applicationId: string): Promise<DokployDeployment[]> {
    const url = `${this.base}/deployment.allByType?id=${encodeURIComponent(applicationId)}&type=application`;
    const json = await this.getJson(url, '拉取 Dokploy 构建记录失败');
    if (!Array.isArray(json)) return [];
    const out: DokployDeployment[] = [];
    for (const raw of json as Array<Record<string, unknown>>) {
      const deploymentId = raw?.deploymentId;
      if (typeof deploymentId !== 'string' || deploymentId === '') continue;
      const status = raw.status;
      out.push({
        deploymentId,
        title: str(raw.title),
        description: str(raw.description),
        // Dokploy 的 deploymentStatus 枚举就是这四个；认不出的当作构建中，别自作主张判死
        status:
          status === 'running' || status === 'done' || status === 'error' || status === 'cancelled'
            ? status
            : 'running',
        errorMessage: str(raw.errorMessage),
        createdAt: str(raw.createdAt),
      });
    }
    return out;
  }

  /**
   * Dokploy 部署队列里的任务（决策 30）。触发到构建记录建出来之间有个空窗——部署是排队执行的，
   * `createDeployment` 要等队列真的开始处理这个任务才调用——这个端点是那段时间里唯一能看到
   * 「这次部署存在」的地方，`data` 就是入队时的 DeploymentJob，带着我们写进去的 title/description。
   *
   * 两个注意点：① 它是**组织级全量**，不按应用过滤，调用方自己筛 applicationId；
   * ② 任务入队时带了 removeOnComplete/removeOnFail，跑完即从队列消失（那时构建记录已经有了）。
   */
  async queueList(): Promise<DokployQueueJob[]> {
    const json = await this.getJson(`${this.base}/deployment.queueList`, '拉取 Dokploy 部署队列失败');
    if (!Array.isArray(json)) return [];
    const out: DokployQueueJob[] = [];
    for (const raw of json as Array<Record<string, unknown>>) {
      const data = (raw?.data ?? {}) as Record<string, unknown>;
      const applicationId = data.applicationId;
      if (typeof applicationId !== 'string' || applicationId === '') continue;
      out.push({
        applicationId,
        title: str(data.titleLog),
        description: str(data.descriptionLog),
        state: str(raw.state),
        timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : 0,
      });
    }
    return out;
  }

  /** 某次构建的日志正文（Dokploy 侧就是对日志文件做 tail -n，tail 上限 10000） */
  async readDeploymentLogs(deploymentId: string, tail: number): Promise<string> {
    const url = `${this.base}/deployment.readLogs?deploymentId=${encodeURIComponent(deploymentId)}&tail=${tail}`;
    const json = await this.getJson(url, '读取 Dokploy 构建日志失败');
    return typeof json === 'string' ? json : '';
  }

  /** 应用当前的容器（appName 是 Dokploy 生成的容器名前缀，取自 application.one） */
  async listContainers(appName: string): Promise<DokployContainer[]> {
    const url = `${this.base}/docker.getContainersByAppNameMatch?appName=${encodeURIComponent(appName)}`;
    const json = await this.getJson(url, '拉取 Dokploy 容器清单失败');
    if (!Array.isArray(json)) return [];
    const out: DokployContainer[] = [];
    for (const raw of json as Array<Record<string, unknown>>) {
      const containerId = raw?.containerId;
      if (typeof containerId !== 'string' || containerId === '') continue;
      out.push({ containerId, name: str(raw.name), state: str(raw.state), status: str(raw.status) });
    }
    return out;
  }

  /** 应用的容器名前缀（appName），运行日志要靠它找容器 */
  async applicationAppName(applicationId: string): Promise<string> {
    const url = `${this.base}/application.one?applicationId=${encodeURIComponent(applicationId)}`;
    const json = await this.getJson(url, '读取 Dokploy 应用详情失败');
    return str((json as Record<string, unknown>)?.appName);
  }

  /**
   * 容器运行日志。Dokploy 只有 WebSocket 这一条路：v0.30.4 上把 tRPC router 全枚举过一遍，
   * REST 侧没有任何读容器日志的过程（deployment.readLogs 读的是构建日志文件，跟容器无关）。
   *
   * 这里不做实时流：带上 tail=N 连上去，收完这一批就断开——服务端跑的是 `docker logs --follow`，
   * 永远不会主动结束，所以边界得我们自己定：静默 IDLE_MS 收工，最多等 HARD_MS、最多收 MAX_BYTES。
   */
  async containerLogs(containerId: string, tail: number): Promise<string> {
    const IDLE_MS = 800;
    const HARD_MS = 15_000;
    const MAX_BYTES = 2_000_000;
    // WS 端点挂在 Dokploy 站点根上，不在 /api 下面
    const url = new URL(`${this.base.replace(/\/api$/, '')}/docker-container-logs`.replace(/^http/, 'ws'));
    url.searchParams.set('containerId', containerId);
    url.searchParams.set('tail', String(tail));
    url.searchParams.set('since', 'all');
    // 鉴权靠 upgrade 请求头上的 x-api-key，Node 内置的 WHATWG WebSocket 不支持自定义头，故用 ws
    const ws = new WebSocket(url, { headers: { 'x-api-key': this.conn.apiToken } });

    const raw = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let received = 0;
      let idle: NodeJS.Timeout | undefined;
      let settled = false;
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(hard);
        clearTimeout(idle);
        ws.terminate();
        // 多字节字符可能被切在两帧里，所以攒完再解码
        if (err) reject(err);
        else resolve(Buffer.concat(chunks).toString('utf8'));
      };
      const hard = setTimeout(() => finish(), HARD_MS);
      ws.on('message', (data: Buffer) => {
        chunks.push(data);
        received += data.length;
        if (received > MAX_BYTES) {
          finish();
          return;
        }
        clearTimeout(idle);
        idle = setTimeout(() => finish(), IDLE_MS);
      });
      // 容器一直没输出时也得收工，不能干等到硬超时
      ws.on('open', () => {
        idle = setTimeout(() => finish(), Math.max(IDLE_MS, 2000));
      });
      // 4000+ 是 Dokploy 自己的拒绝码（参数非法 / 无权限），要如实报出来而不是当成正常收尾
      ws.on('close', (code: number, reason: Buffer) =>
        finish(code >= 4000 ? new Error(`Dokploy 拒绝读取（${code} ${reason.toString() || '无权限或参数非法'}）`) : undefined),
      );
      ws.on('error', (err: Error) => finish(err));
    });

    // 服务端是在 pty 里跑 docker logs，行尾是 \r\n
    const text = raw.replace(/\r\n/g, '\n');
    return text.length > MAX_BYTES ? `（日志过长，只保留末尾）\n${text.slice(-MAX_BYTES)}` : text;
  }

  private async getJson(url: string, failNote: string): Promise<unknown> {
    const res = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      throw new Error(`${failNote}（HTTP ${res.status}）: ${(await res.text()).slice(0, 200)}`);
    }
    return res.json();
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
