import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { createHmac, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { SiteSetupCheck } from '@eat/shared';
import { PG_POOL } from '../db/db.module';
import { siteSettings } from '../db/schema';
import { loadConfig } from '../config';
import { AuditService } from '../audit/audit.service';
import { DokploySettingsService } from '../deploy/dokploy-settings.service';
import { SiteSettingsStore, setupBusy, type SiteSettingRow } from './site-settings.store';
import { SiteDns, SiteSetupError, type SiteDnsClient } from './site-dns.service';
import { SiteInfrastructure } from './site-infrastructure.service';

const LOCK = 1950536502;
export function siteProbeMarker(row: SiteSettingRow) {
  return createHmac('sha256', loadConfig().kek)
    .update(`site-probe:${row.resourceKey}:${row.operationId}`)
    .digest('hex');
}
@Injectable()
export class SiteSetupService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(SiteSetupService.name);
  private readonly abort = new AbortController();
  private job?: Promise<void>;
  constructor(
    private readonly store: SiteSettingsStore,
    private readonly dokploy: DokploySettingsService,
    private readonly infra: SiteInfrastructure,
    private readonly dns: SiteDns,
    private readonly audit: AuditService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}
  private async lock(): Promise<PoolClient> {
    const connection = await this.pool.connect();
    try {
      if (!(await connection.query('select pg_try_advisory_lock($1) as acquired', [LOCK])).rows[0].acquired)
        throw new ConflictException('页面配置正在被其他操作处理，请稍后重试');
    } catch (e) {
      connection.release();
      throw e;
    }
    return connection;
  }
  private async release(c: PoolClient) {
    try {
      await c.query('select pg_advisory_unlock($1)', [LOCK]);
    } finally {
      c.release();
    }
  }
  async onModuleInit() {
    const row = await this.store.row();
    if (!row || !setupBusy(row.status)) return;
    let lock: PoolClient;
    try {
      lock = await this.lock();
    } catch (e) {
      if (e instanceof ConflictException) return;
      throw e;
    }
    try {
      await this.store.db
        .update(siteSettings)
        .set({
          status: 'failed',
          lastError: '上次启停被服务重启中断。请先停用以清理入口，再重试启用。',
          operationId: null,
          updatedAt: new Date(),
        })
        .where(and(eq(siteSettings.id, 1), eq(siteSettings.operationId, row.operationId!)));
    } finally {
      await this.release(lock);
    }
  }
  async onApplicationShutdown() {
    this.abort.abort();
    await this.job;
  }
  async tlsOptions(applicationId: string) {
    const client = await this.dokploy.client();
    const app = await client.getApplication(applicationId);
    return this.infra.tlsOptions(client, app.serverId);
  }
  async start(actorId: string, disable = false) {
    const lock = await this.lock();
    let row: SiteSettingRow;
    try {
      row = await this.store.db.transaction(async (tx) => {
        const [r] = await tx.select().from(siteSettings).where(eq(siteSettings.id, 1)).for('update');
        if (!r) throw new ConflictException('请先保存页面配置');
        if (setupBusy(r.status)) throw new ConflictException('页面正在检查或配置，请等待完成');
        if (!disable && r.status === 'enabled') throw new ConflictException('页面已启用；修改配置前请先停用');
        const [next] = await tx
          .update(siteSettings)
          .set({
            status: disable ? 'disabling' : 'checking',
            operationId: randomUUID(),
            operationStartedAt: new Date(),
            checks: [],
            lastError: '',
            updatedAt: new Date(),
          })
          .where(eq(siteSettings.id, 1))
          .returning();
        return next;
      });
    } catch (e) {
      await this.release(lock);
      throw e;
    }
    this.job = this.run(row, actorId, disable)
      .catch(() => this.logger.error('页面启停任务异常，状态请以系统设置为准'))
      .finally(() => this.release(lock));
    return this.store.info();
  }
  private async run(row: SiteSettingRow, actorId: string, disable: boolean) {
    let client: Awaited<ReturnType<DokploySettingsService['client']>> | undefined;
    let createdDns: { id: string; client: SiteDnsClient } | null = null;
    const checks: SiteSetupCheck[] = [];
    const update = async (values: Partial<typeof siteSettings.$inferInsert>) => {
      await this.store.db
        .update(siteSettings)
        .set({ ...values, updatedAt: new Date() })
        .where(and(eq(siteSettings.id, 1), eq(siteSettings.operationId, row.operationId!)));
    };
    const check = async (id: string, name: string, phase: SiteSetupCheck['phase'], fn: () => Promise<unknown>) => {
      const item: SiteSetupCheck = {
        id,
        name,
        phase,
        status: 'running',
        message: '进行中',
        checkedAt: new Date().toISOString(),
      };
      checks.push(item);
      await update({ checks: [...checks] });
      try {
        if (this.abort.signal.aborted) throw new SiteSetupError('服务正在停止，请重试');
        await fn();
        item.status = 'passed';
        item.message = '通过';
      } catch (e) {
        item.status = 'failed';
        item.message =
          e instanceof SiteSetupError || (e instanceof Error && e.message.startsWith('Dokploy '))
            ? e.message
            : '检查未通过，请检查连接、配置及访问权限后重试';
        throw new SiteSetupError(item.message);
      } finally {
        item.checkedAt = new Date().toISOString();
        await update({ checks: [...checks] });
      }
    };
    try {
      await check('dokploy', '部署后台连接与 EAT 转发目标', 'preflight', async () => {
        client = await this.dokploy.client();
        if (row.routeConfigured) {
          await this.infra.withdraw(client, row);
          await update({ routeConfigured: false });
          row.routeConfigured = false;
        }
        if (disable) return;
        const app = await client.getApplication(row.platformApplicationId);
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(app.appName))
          throw new SiteSetupError('所选 EAT 应用没有有效的容器名称');
        row.serverId = app.serverId;
        row.upstreamUrl = row.upstreamUrl || `http://${app.appName}:${row.upstreamPort}`;
        if (new URL(row.platformUrl || loadConfig().publicUrl).protocol !== 'https:')
          throw new SiteSetupError('请在页面设置中填写 EAT 控制台的 HTTPS 地址，页面登录和评论需要安全的平台地址');
        await update({ serverId: row.serverId });
        await this.infra.readMain(client, row.serverId);
      });
      if (disable) {
        await check('stop', '撤下页面入口（保留文件、历史版本与证书）', 'provision', () =>
          this.infra.withdraw(client!, row),
        );
        await this.audit.record({
          actorId,
          action: disable ? 'site.capability.disabled' : 'site.capability.enabled',
          targetType: 'site_setting',
          targetId: '1',
        });
        await update({ status: 'disabled', operationId: null, lastError: '', routeConfigured: false });
      } else {
        // 重试前先撤下上次留下的专用路由，绝不改动其他应用。
        await check('clean', '确认专用入口可写并清理上次未完成的路由', 'preflight', () =>
          this.infra.withdraw(client!, row),
        );
        await check('oss', 'OSS 私有访问及上传 / 读取 / 删除权限', 'preflight', () => this.infra.checkOss(row));
        await check('certificate', '证书或 DNS 证书解析器配置', 'preflight', () =>
          this.infra.checkCertificate(client!, row),
        );
        let dnsClient: SiteDnsClient | undefined;
        if (['alidns', 'cloudflare'].includes(row.tlsMode)) {
          await check('dns-permissions', 'DNS 服务商连接与 TXT 记录读写 / 删除权限', 'preflight', async () => {
            dnsClient = await this.dns.connect(row);
            await this.dns.checkPermissions(dnsClient, row);
          });
          if (row.autoDns)
            await check('dns-create', `添加 *.${row.domain} 解析（不覆盖已有记录）`, 'provision', async () => {
              createdDns = await this.dns.ensureWildcard(dnsClient!, row);
            });
        }
        await check('dns', `通配 DNS 解析指向部署入口${row.autoDns ? '（最多等待 2 分钟）' : ''}`, 'preflight', () =>
          this.infra.waitDns(row, this.abort.signal),
        );
        await update({ status: 'provisioning' });
        await check('gateway', '确认共享反向代理运行（必要时自动启动）', 'provision', () =>
          this.infra.ensureGateway(client!, row, this.abort.signal),
        );
        await update({ routeConfigured: true });
        row.routeConfigured = true;
        await check('routes', '配置共享 HTTPS 入口与证书自动续期', 'provision', () =>
          this.infra.configure(client!, row, row.upstreamUrl),
        );
        await update({ status: 'verifying' });
        await check('https', '验证 HTTPS 信任链、域名、有效期、转发及 HTTP 跳转（最长 5 分钟）', 'postflight', () =>
          this.infra.verify(row, siteProbeMarker(row), this.abort.signal, async (message) => {
            const item = checks.find((c) => c.id === 'https')!;
            item.message = message;
            await update({ checks: [...checks] });
          }),
        );
        await this.audit.record({
          actorId,
          action: disable ? 'site.capability.disabled' : 'site.capability.enabled',
          targetType: 'site_setting',
          targetId: '1',
        });
        await update({ status: 'enabled', operationId: null, lastError: '' });
      }
    } catch (e) {
      let message = e instanceof SiteSetupError ? e.message : '页面配置失败，请检查连接、配置及访问权限';
      if (!disable && client) {
        try {
          await check('rollback', '撤下本次未成功启用的页面路由', 'provision', async () => {
            await this.infra.withdraw(client!, row);
            await update({ routeConfigured: false });
          });
        } catch {
          message += '；入口清理失败，请点击停用重试清理';
        }
      }
      if (createdDns) {
        try {
          const created = createdDns as { id: string; client: SiteDnsClient };
          await created.client.remove(created.id);
        } catch {
          message += '；本次新增的通配 DNS 记录清理失败，请到 DNS 控制台检查';
        }
      }
      await update({ status: 'failed', operationId: null, lastError: message });
    }
  }
}
