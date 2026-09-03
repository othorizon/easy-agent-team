import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type {
  ConnectionTestResult,
  DokployApplication,
  DokployProject,
  DokploySettingsInfo,
  DokploySshKey,
  TestDokploySettingsRequest,
  UpdateDokploySettingsRequest,
} from '@eat/shared';
import { decryptSecret, encryptSecret } from '../common/crypto';
import { DB, type Db } from '../db/db.module';
import { dokploySettings } from '../db/schema';
import { DokployClient } from './dokploy.client';

/** 自助建应用需要的 Dokploy 落点（决策 31）：建在哪个环境下、绑哪把 SSH key */
export interface DokployProvisioning {
  client: DokployClient;
  environmentId: string;
  /** 空串 = 不绑 key（只能拉公开仓库） */
  sshKeyId: string;
  /** 自动分配域名的后缀（决策 32）；空串 = 不分配 */
  domainSuffix: string;
  domainHttps: boolean;
}

/**
 * Dokploy 接入配置（管理员维护的单行）与客户端工厂。
 * 应用服务与部署服务都从这里拿 client，避免两边各存一份「怎么连 Dokploy」的逻辑。
 */
@Injectable()
export class DokploySettingsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async settingsRow() {
    return (await this.db.select().from(dokploySettings).limit(1))[0];
  }

  async getSettings(): Promise<DokploySettingsInfo> {
    const row = await this.settingsRow();
    if (!row) {
      return {
        apiUrl: '',
        apiTokenMasked: '',
        enabled: false,
        configured: false,
        projectId: '',
        environmentId: '',
        sshKeyId: '',
        domainSuffix: '',
        domainHttps: false,
        provisioningReady: false,
      };
    }
    const token = decryptSecret(row.apiTokenEncrypted);
    return {
      apiUrl: row.apiUrl,
      apiTokenMasked: token.length > 8 ? `${token.slice(0, 4)}****${token.slice(-4)}` : '****',
      enabled: row.enabled,
      configured: true,
      projectId: row.projectId,
      environmentId: row.environmentId,
      sshKeyId: row.sshKeyId,
      domainSuffix: row.domainSuffix,
      domainHttps: row.domainHttps,
      provisioningReady: row.enabled && row.projectId !== '' && row.environmentId !== '',
    };
  }

  async updateSettings(dto: UpdateDokploySettingsRequest): Promise<DokploySettingsInfo> {
    const row = await this.settingsRow();
    const apiTokenEncrypted = dto.apiToken ? encryptSecret(dto.apiToken) : (row?.apiTokenEncrypted ?? encryptSecret(''));
    const values = {
      apiUrl: dto.apiUrl,
      apiTokenEncrypted,
      enabled: dto.enabled,
      projectId: dto.projectId,
      environmentId: dto.environmentId,
      sshKeyId: dto.sshKeyId,
      domainSuffix: dto.domainSuffix,
      domainHttps: dto.domainHttps,
    };
    if (row) {
      await this.db
        .update(dokploySettings)
        .set({ ...values, updatedAt: sql`now()` })
        .where(eq(dokploySettings.id, row.id));
    } else {
      await this.db.insert(dokploySettings).values(values);
    }
    return this.getSettings();
  }

  /**
   * 连通性测试：用传入的表单值（token 为空回落到已保存的 token）调用 Dokploy 只读端点。
   * 不要求 enabled（管理员可先测通再启用），失败不抛错。
   */
  async testSettings(dto: TestDokploySettingsRequest): Promise<ConnectionTestResult> {
    const row = await this.settingsRow();
    const apiToken = dto.apiToken || (row ? decryptSecret(row.apiTokenEncrypted) : '');
    if (!apiToken) return { ok: false, message: '未提供 API Token，且没有已保存的 Token 可用', latencyMs: 0 };
    const startedAt = Date.now();
    try {
      await new DokployClient({ apiUrl: dto.apiUrl, apiToken }).testConnection();
      return { ok: true, message: 'Dokploy 连接成功，token 有效', latencyMs: Date.now() - startedAt };
    } catch (err) {
      return { ok: false, message: `连接失败: ${describe(err)}`, latencyMs: Date.now() - startedAt };
    }
  }

  /** 已启用的 Dokploy 客户端；未配置或停用时 503 */
  async client(): Promise<DokployClient> {
    const row = await this.settingsRow();
    if (!row || !row.enabled) {
      throw new ServiceUnavailableException({ error: 'DOKPLOY_UNAVAILABLE', message: 'Dokploy 未配置或已停用（系统设置 → Dokploy）' });
    }
    return new DokployClient({ apiUrl: row.apiUrl, apiToken: decryptSecret(row.apiTokenEncrypted) });
  }

  /**
   * 自助建应用的落点（决策 31）。项目 / 环境没配好就不能建，报错要指到管理员该去改的位置——
   * 这是用户侧最常撞到的一道墙，文案不能只说「不可用」。
   */
  async provisioning(): Promise<DokployProvisioning> {
    const client = await this.client();
    const row = await this.settingsRow();
    if (!row || row.projectId === '' || row.environmentId === '') {
      throw new ServiceUnavailableException({
        error: 'DOKPLOY_PROVISIONING_UNCONFIGURED',
        message: '管理员尚未配置自助创建应用所需的 Dokploy 项目与环境（系统设置 → Dokploy），配好后再试',
      });
    }
    return {
      client,
      environmentId: row.environmentId,
      sshKeyId: row.sshKeyId,
      domainSuffix: row.domainSuffix,
      domainHttps: row.domainHttps,
    };
  }

  /**
   * Dokploy 应用清单（决策 27）：管理员「挂载既有应用」时用，免去手抄 application id。
   * 清单只含应用名与 id，不含任何凭证。
   */
  async listApplications(): Promise<DokployApplication[]> {
    const client = await this.client();
    return this.callDokploy(() => client.listApplications(), '拉取 Dokploy 应用清单失败');
  }

  /** 管理员选「自助建应用落在哪」用：项目及其环境 */
  async listProjects(): Promise<DokployProject[]> {
    const client = await this.client();
    return this.callDokploy(() => client.listProjects(), '拉取 Dokploy 项目清单失败');
  }

  /** 管理员选「自助建应用绑哪把 key」用 */
  async listSshKeys(): Promise<DokploySshKey[]> {
    const client = await this.client();
    return this.callDokploy(() => client.listSshKeys(), '拉取 Dokploy SSH key 清单失败');
  }

  /**
   * 调 Dokploy 的统一错误包装：Node fetch 的网络错误只报 "fetch failed"，
   * 真正的原因（ECONNREFUSED 等）在 cause 里，不带出来排查会很痛苦。
   */
  async callDokploy<T>(fn: () => Promise<T>, note: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new ServiceUnavailableException({ error: 'DOKPLOY_UNAVAILABLE', message: `${note}: ${describe(err)}` });
    }
  }
}

function describe(err: unknown): string {
  const e = err as Error & { cause?: { message?: string } };
  return e.cause?.message ? `${e.message}（${e.cause.message}）` : e.message;
}
