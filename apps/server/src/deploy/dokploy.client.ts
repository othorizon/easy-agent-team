/**
 * Dokploy API 客户端（挂载式：平台不自建部署系统）。
 * 端点基于 Dokploy REST API（x-api-key 认证）：
 *   POST {apiUrl}/application.deploy   { applicationId, title?, description? }（决策 30）
 *   GET  {apiUrl}/application.one?applicationId=...  → { appName }（找容器用）
 *   GET  {apiUrl}/project.all          （只读；连通性测试、应用清单、项目/环境清单都用它）
 *   GET  {apiUrl}/sshKey.allForApps    → 组织内的 SSH key（只有 id 与名字，决策 31）
 *   POST {apiUrl}/application.create   { name, description, environmentId } → 新建 application（决策 31）
 *   POST {apiUrl}/application.saveGitProvider  → 绑自定义 Git 源（地址 / 分支 / SSH key）
 *   POST {apiUrl}/application.saveBuildType    → 构建方式（static / dockerfile）
 *   POST {apiUrl}/application.saveEnvironment  → 运行时 env / 构建时 buildArgs（整体覆盖）
 *   POST {apiUrl}/application.delete   { applicationId }
 *   POST {apiUrl}/domain.create        { host, port, https, certificateType, applicationId, domainType }（决策 32）
 *   POST {apiUrl}/domain.update        { domainId, host, port, ... }（host 必带）
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
import type {
  AppBuildType,
  DokployApplication,
  DokployContainer,
  DokployDeployment,
  DokployProject,
  DokploySshKey,
} from '@eat/shared';
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

/** application.one 里用得上的字段（真实响应有一百多个字段，这里只取平台要的） */
export interface DokployApplicationDetail {
  applicationId: string;
  name: string;
  /** Dokploy 生成的容器名前缀，找容器 / 读运行日志靠它 */
  appName: string;
  /** 运行时环境变量（dotenv 文本） */
  env: string;
  /** 构建时变量（dotenv 文本），Dockerfile 里以 ARG 取用 */
  buildArgs: string;
  buildSecrets: string;
  createEnvFile: boolean;
  sourceType: string;
  buildType: string;
  customGitUrl: string;
  customGitBranch: string;
}

/** 自定义 Git 源（决策 31：平台自建的应用一律走这条，不走 GitHub/GitLab 等托管商集成） */
export interface DokployGitProviderInput {
  applicationId: string;
  customGitUrl: string;
  customGitBranch: string;
  /** 仓库内的构建根目录，Dokploy 默认 `/` */
  customGitBuildPath: string;
  /** null = 不绑 key（只能拉公开仓库） */
  customGitSSHKeyId: string | null;
}

export interface DokployBuildTypeInput {
  applicationId: string;
  buildType: AppBuildType;
  dockerfile: string;
  dockerContextPath: string;
  publishDirectory: string;
  isStaticSpa: boolean;
}

export interface DokployEnvironmentInput {
  applicationId: string;
  env: string;
  buildArgs: string;
  buildSecrets: string;
  createEnvFile: boolean;
}

/** 给 application 绑一条域名（决策 32）：路径固定 `/`，流量转发到容器的 port */
export interface DokployDomainInput {
  applicationId: string;
  host: string;
  port: number;
  https: boolean;
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
      throw new Error(`部署后台返回 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
      throw new Error(`部署后台返回 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
      throw new Error(`部署后台部署触发失败（HTTP ${res.status}）: ${(await res.text()).slice(0, 300)}`);
    }
  }

  // ---------- 构建日志 / 运行日志（决策 28） ----------

  /**
   * 某应用的构建记录列表（最新在前）。Dokploy 的一次「构建」= 一条 deployment 记录，
   * 它比 application.applicationStatus 精确：后者是应用当前状态，同一应用被别人再次部署就会被覆盖。
   */
  async listDeployments(applicationId: string): Promise<DokployDeployment[]> {
    const url = `${this.base}/deployment.allByType?id=${encodeURIComponent(applicationId)}&type=application`;
    const json = await this.getJson(url, '拉取部署后台构建记录失败');
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
    const json = await this.getJson(`${this.base}/deployment.queueList`, '拉取部署后台部署队列失败');
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
    const json = await this.getJson(url, '读取部署后台构建日志失败');
    return typeof json === 'string' ? json : '';
  }

  /** 应用当前的容器（appName 是 Dokploy 生成的容器名前缀，取自 application.one） */
  async listContainers(appName: string): Promise<DokployContainer[]> {
    const url = `${this.base}/docker.getContainersByAppNameMatch?appName=${encodeURIComponent(appName)}`;
    const json = await this.getJson(url, '拉取部署后台容器清单失败');
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
    const json = await this.getJson(url, '读取部署后台应用详情失败');
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
        finish(code >= 4000 ? new Error(`部署后台拒绝读取（${code} ${reason.toString() || '无权限或参数非法'}）`) : undefined),
      );
      ws.on('error', (err: Error) => finish(err));
    });

    // 服务端是在 pty 里跑 docker logs，行尾是 \r\n
    const text = raw.replace(/\r\n/g, '\n');
    return text.length > MAX_BYTES ? `（日志过长，只保留末尾）\n${text.slice(-MAX_BYTES)}` : text;
  }

  // ---------- 项目 / 环境 / SSH key 清单（管理员配置自助建应用的落点，决策 31） ----------

  /**
   * Dokploy 上的项目及其环境。新版 Dokploy 的 application 必须建在某个环境下（environmentId 必填），
   * 所以管理员要选到环境这一层；没有 environments 的老版本这里回空数组，自助建应用随之不可用。
   */
  async listProjects(): Promise<DokployProject[]> {
    const json = await this.getJson(`${this.base}/project.all`, '拉取 Dokploy 项目清单失败');
    if (!Array.isArray(json)) return [];
    const out: DokployProject[] = [];
    for (const raw of json as Array<Record<string, unknown>>) {
      const projectId = raw?.projectId;
      if (typeof projectId !== 'string' || projectId === '') continue;
      const environments: DokployProject['environments'] = [];
      if (Array.isArray(raw.environments)) {
        for (const env of raw.environments as Array<Record<string, unknown>>) {
          const environmentId = env?.environmentId;
          if (typeof environmentId !== 'string' || environmentId === '') continue;
          environments.push({ environmentId, name: str(env.name) || environmentId, isDefault: env.isDefault === true });
        }
      }
      out.push({ projectId, name: str(raw.name) || projectId, environments });
    }
    return out;
  }

  /** 组织内的 SSH key（sshKey.allForApps 只回 id 与名字，不含私钥） */
  async listSshKeys(): Promise<DokploySshKey[]> {
    const json = await this.getJson(`${this.base}/sshKey.allForApps`, '拉取 Dokploy SSH key 清单失败');
    if (!Array.isArray(json)) return [];
    const out: DokploySshKey[] = [];
    for (const raw of json as Array<Record<string, unknown>>) {
      const sshKeyId = raw?.sshKeyId;
      if (typeof sshKeyId !== 'string' || sshKeyId === '') continue;
      out.push({ sshKeyId, name: str(raw.name) || sshKeyId });
    }
    return out;
  }

  // ---------- 建应用 / 配 Git 源 / 配构建方式 / 删应用（决策 31） ----------

  /**
   * 新建 application。不传 appName：让 Dokploy 自己生成容器名（`<name>-<随机后缀>`），
   * 传固定值会撞它的全局唯一校验（同名应用在别的项目下很常见）。
   */
  async createApplication(input: { name: string; description: string; environmentId: string }): Promise<{
    applicationId: string;
    appName: string;
  }> {
    const json = await this.postJson(`${this.base}/application.create`, input, '在部署后台创建应用失败');
    const row = (json ?? {}) as Record<string, unknown>;
    const applicationId = str(row.applicationId);
    if (!applicationId) throw new Error('部署后台创建应用的响应里没有 applicationId');
    return { applicationId, appName: str(row.appName) };
  }

  /**
   * 绑自定义 Git 源。字段名照 Dokploy 控制台自己的表单发（watchPaths 必须是数组、enableSubmodules 必须带），
   * 少一个键 zod 就拒；customGitSSHKeyId 传 null 表示不绑 key。
   */
  async saveGitProvider(input: DokployGitProviderInput): Promise<void> {
    await this.postJson(
      `${this.base}/application.saveGitProvider`,
      { ...input, watchPaths: [], enableSubmodules: false },
      '在部署后台配置 Git 源失败',
    );
  }

  /**
   * 构建方式。只开放 static / dockerfile 两种（决策 31）。与另一种方式无关的字段一律传 null，
   * 与 Dokploy 控制台的做法一致；static 的 publishDirectory 虽然它的表单不露出，但构建器读的就是这个字段。
   */
  async saveBuildType(input: DokployBuildTypeInput): Promise<void> {
    const docker = input.buildType === 'dockerfile';
    await this.postJson(
      `${this.base}/application.saveBuildType`,
      {
        applicationId: input.applicationId,
        buildType: input.buildType,
        dockerfile: docker ? input.dockerfile : null,
        dockerContextPath: docker ? input.dockerContextPath : null,
        dockerBuildStage: null,
        herokuVersion: null,
        railpackVersion: null,
        publishDirectory: docker ? null : input.publishDirectory,
        isStaticSpa: docker ? null : input.isStaticSpa,
      },
      '在部署后台配置构建方式失败',
    );
  }

  /** 应用详情：env / buildArgs / appName 等平台用得上的字段 */
  async getApplication(applicationId: string): Promise<DokployApplicationDetail> {
    const url = `${this.base}/application.one?applicationId=${encodeURIComponent(applicationId)}`;
    const raw = ((await this.getJson(url, '读取部署后台应用详情失败')) ?? {}) as Record<string, unknown>;
    return {
      applicationId: str(raw.applicationId) || applicationId,
      name: str(raw.name),
      appName: str(raw.appName),
      env: str(raw.env),
      buildArgs: str(raw.buildArgs),
      buildSecrets: str(raw.buildSecrets),
      // Dokploy 默认 true；缺字段（老版本）也按 true，别把人家的 .env 生成关了
      createEnvFile: raw.createEnvFile !== false,
      sourceType: str(raw.sourceType),
      buildType: str(raw.buildType),
      customGitUrl: str(raw.customGitUrl),
      customGitBranch: str(raw.customGitBranch),
    };
  }

  /** 写 env / buildArgs / buildSecrets：Dokploy 这个端点是整体覆盖，四个字段都得带上 */
  async saveEnvironment(input: DokployEnvironmentInput): Promise<void> {
    await this.postJson(`${this.base}/application.saveEnvironment`, input, '在部署后台写入环境变量失败');
  }

  /** 删除 application。Dokploy 上已经没有这个应用（404）视为删成功，别让平台侧的记录因此删不掉 */
  async deleteApplication(applicationId: string): Promise<void> {
    const res = await fetch(`${this.base}/application.delete`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ applicationId }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`在部署后台删除应用失败（HTTP ${res.status}）: ${(await res.text()).slice(0, 300)}`);
    }
  }

  // ---------- 域名（决策 32） ----------

  /**
   * 给应用绑域名。请求体是 Dokploy 控制台表单的最小集（对 v0.30.5 真机验证过）：path 固定 `/`；
   * https 时证书类型 letsencrypt（要 Dokploy 自己配好证书邮箱），否则 none。
   * 建完 Dokploy 立刻把 Traefik 路由写进文件 provider，不用等下次部署。
   */
  async createDomain(input: DokployDomainInput): Promise<{ domainId: string }> {
    const json = await this.postJson(
      `${this.base}/domain.create`,
      {
        host: input.host,
        path: '/',
        port: input.port,
        https: input.https,
        certificateType: input.https ? 'letsencrypt' : 'none',
        applicationId: input.applicationId,
        domainType: 'application',
      },
      '在部署后台绑定域名失败',
    );
    const domainId = str(((json ?? {}) as Record<string, unknown>).domainId);
    if (!domainId) throw new Error('部署后台绑定域名的响应里没有 domainId');
    return { domainId };
  }

  /** 改域名转发的容器端口。domain.update 的 zod 把 host 定成必填（真机验证），所以关键字段整组带上 */
  async updateDomain(input: DokployDomainInput & { domainId: string }): Promise<void> {
    await this.postJson(
      `${this.base}/domain.update`,
      {
        domainId: input.domainId,
        host: input.host,
        path: '/',
        port: input.port,
        https: input.https,
        certificateType: input.https ? 'letsencrypt' : 'none',
      },
      '在部署后台更新域名失败',
    );
  }

  private async postJson(url: string, body: unknown, failNote: string): Promise<unknown> {
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`${failNote}（HTTP ${res.status}）: ${(await res.text()).slice(0, 300)}`);
    }
    const text = await res.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
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
