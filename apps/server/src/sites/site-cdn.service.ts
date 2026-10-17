import { Inject, Injectable, Logger, type OnModuleInit, type OnApplicationShutdown } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { sites, siteVersions } from '../db/schema';
import type { Pool } from 'pg';
import { isIP } from 'node:net';
import { getDomain } from 'tldts';
import { PG_POOL } from '../db/db.module';
import { AuditService } from '../audit/audit.service';
import { SiteCdnPurgeService } from './site-cdn-purge.service';
import { SiteCdnStore, type SiteCdnRow } from './site-cdn.store';
import { SiteCdnClient, CdnApiError, cdnFunction, type CdnCredentials } from './site-cdn.client';
import {
  cdnDomain,
  cdnFunctions,
  legacyCdnFunctions,
  cdnConfigsToCheck,
  checkCdnOrigin,
  configDigest,
  SiteCdnInfrastructure,
} from './site-cdn.infrastructure';
import { SiteDns, SiteSetupError, type SiteDnsClient, type DnsRecord } from './site-dns.service';
import { SiteInfrastructure } from './site-infrastructure.service';
import type { SiteSettingRow } from './site-settings.store';

class CdnConflict extends SiteSetupError {}
class WaitDns extends SiteSetupError {}
const normalized = (s: string) => s.toLowerCase().replace(/\.$/, '');
const sameRecord = (a: DnsRecord, b: DnsRecord) =>
  a.id === b.id &&
  a.type === b.type &&
  normalized(a.content) === normalized(b.content) &&
  (a.ttl ?? 600) === (b.ttl ?? 600) &&
  (a.proxied ?? false) === (b.proxied ?? false) &&
  (a.line ?? 'default') === (b.line ?? 'default') &&
  (a.status ?? 'ENABLE').toUpperCase() === (b.status ?? 'ENABLE').toUpperCase();
@Injectable()
export class SiteCdnService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(SiteCdnService.name);
  private timer?: ReturnType<typeof setInterval>;
  private job?: Promise<void>;
  private stopped = false;
  constructor(
    private readonly store: SiteCdnStore,
    private readonly api: SiteCdnClient,
    private readonly infra: SiteCdnInfrastructure,
    private readonly dns: SiteDns,
    private readonly origin: SiteInfrastructure,
    private readonly audit: AuditService,
    private readonly purges: SiteCdnPurgeService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => this.wake(), 30_000);
    this.timer.unref();
    this.wake();
  }
  private wake() {
    if (!this.job && !this.stopped)
      this.job = this.tick()
        .catch(() => this.logger.error('CDN 后台检查失败，将稍后重试'))
        .finally(() => {
          this.job = undefined;
        });
  }
  async onApplicationShutdown() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.job;
  }
  /** The same PostgreSQL session lock as Folio setup; restart resumes the persisted journal. */
  async tick() {
    const connection = await this.pool.connect();
    let held = false,
      lost = false;
    const onLost = () => {
      lost = true;
    };
    connection.on('error', onLost);
    try {
      held = (await connection.query('select pg_try_advisory_lock($1) as acquired', [1950536502])).rows[0]
        .acquired;
      if (!held) return;
      const guard = () => {
        if (lost || this.stopped) throw new SiteSetupError('CDN 任务已中断');
      };
      await this.purges.tick(guard);
      const row = await this.store.row();
      if (
        !row ||
        row.status === 'disabled' ||
        row.status === 'conflict' ||
        (!row.enabled && !row.resources.owned && !row.resources.creating) ||
        (row.retryAt && row.retryAt.getTime() > Date.now())
      )
        return;
      const base = await this.store.settings.required();
      base.gatewayTarget = base.gatewayTarget.replace(/^\[|\]$/g, '');
      const credentials = this.store.credentials(row, base);
      try {
        guard();
        if (row.enabled) await this.enable(row, base, credentials, guard);
        else await this.disable(row, base, credentials, guard);
      } catch (e) {
        if (lost || this.stopped) return;
        let rollbackError = '';
        if (
          row.enabled &&
          !row.connected &&
          row.resources.dnsSwitched &&
          row.autoDns &&
          !(e instanceof CdnConflict) &&
          !lost
        ) {
          try {
            await this.switchDns(row, base, false, guard);
            await this.exactDns(row, base, false, guard);
            await this.origin.checkDns(base);
          } catch {
            rollbackError = '；源站 DNS 自动恢复未完成，请保留 CDN 并按指引恢复解析';
          }
        }
        const message =
          (e instanceof SiteSetupError || e instanceof CdnApiError
            ? e.message
            : 'CDN 操作失败，请检查连接与配置后重试') + rollbackError;
        await this.store.patch({
          status: e instanceof CdnConflict ? 'conflict' : e instanceof WaitDns ? 'awaiting_dns' : 'failed',
          lastError: message,
          attempts: row.attempts + 1,
          retryAt:
            e instanceof CdnConflict
              ? null
              : new Date(Date.now() + Math.min(3600_000, 30_000 * 2 ** Math.min(row.attempts, 7))),
        });
        await this.audit.record({
          actorId: row.actorId,
          action: 'site.cdn.failed',
          targetType: 'site_cdn',
          targetId: '1',
          meta: { phase: row.phase, status: e instanceof CdnConflict ? 'conflict' : 'retry' },
        });
      }
    } finally {
      connection.off('error', onLost);
      try {
        if (held && !lost) await connection.query('select pg_advisory_unlock($1)', [1950536502]);
      } finally {
        connection.release(lost);
      }
    }
  }
  private async phase(row: SiteCdnRow, phase: string, status: SiteCdnRow['status'] = 'provisioning') {
    row.phase = phase;
    await this.store.patch({ phase, status, lastError: '' });
  }
  private async journal(row: SiteCdnRow) {
    await this.store.patch({ resources: { ...row.resources } });
  }
  private async certificateVerification(
    row: SiteCdnRow,
    base: SiteSettingRow,
    c: CdnCredentials,
    configs: any[],
    guard: () => void,
  ) {
    const waiting = () => new SiteSetupError('等待回源证书校验配置下发完成，将保留已保存的选择');
    const settle = async () => {
      const change = row.resources.certificateVerificationChange!;
      if (configDigest(configs) === change.from) {
        if (configs.some((v) => v.Status !== 'success')) throw waiting();
        guard();
        await this.phase(row, '更新 CDN 回源证书校验；保留 HTTPS 回源');
        await this.api.call(c, 'BatchSetCdnDomainConfig', {
          DomainNames: cdnDomain(base),
          Functions: JSON.stringify([
            cdnFunction('origin_certificate_verification', { [change.arg]: change.enabled ? 'on' : 'off' }),
          ]),
        });
        guard();
        configs = cdnConfigsToCheck(await this.infra.configurations(c, cdnDomain(base)));
      }
      const digest = configDigest(configs);
      if (digest === change.from) throw waiting();
      if (digest !== change.to) throw new CdnConflict('CDN 配置发生外部修改，已暂停回源证书校验更新');
      if (configs.some((v) => v.Status !== 'success')) throw waiting();
      row.resources.configDigest = row.resources.configured ? digest : undefined;
      row.resources.certificateVerificationChange = undefined;
      await this.journal(row);
    };
    if (row.resources.certificateVerificationChange) await settle();
    const existing = configs.filter((v) => v.FunctionName === 'origin_certificate_verification');
    if (!existing.length) return configs;
    const rule = existing[0];
    const args = rule.FunctionArgs?.FunctionArg ?? [];
    const arg = args[0]?.ArgName;
    if (
      existing.length !== 1 ||
      !['enable', 'enabled'].includes(arg) ||
      !['on', 'off'].includes(args[0]?.ArgValue) ||
      configDigest([rule]) !== configDigest([cdnFunction('origin_certificate_verification', { [arg]: args[0].ArgValue })])
    ) throw new CdnConflict('CDN 回源证书校验存在未知参数或条件，保留现有配置');
    if (row.resources.certificateVerificationArg !== arg) {
      row.resources.certificateVerificationArg = arg;
      await this.journal(row);
    }
    const desired = cdnFunctions(row, base).find((f) => f.functionName === 'origin_certificate_verification')!;
    if (configDigest([rule]) === configDigest([desired])) return configs;
    const known = [...cdnFunctions(row, base), ...legacyCdnFunctions(row, base)];
    if (configs.some((v) => v !== rule && !known.some((f) => configDigest([v]) === configDigest([f]))))
      throw new CdnConflict('CDN 存在未知配置，保留现状，请核对外部修改');
    if (configs.some((v) => v.Status !== 'success')) throw waiting();
    row.resources.certificateVerificationChange = {
      from: configDigest(configs),
      to: configDigest(configs.map((v) => v === rule ? desired : v)),
      enabled: row.verifyOriginCertificate === true,
      arg,
    };
    // Record both exact fingerprints before the provider call: a lost response can resume
    // either side of this one-rule change without accepting unrelated external edits.
    await this.journal(row);
    await settle();
    return configs;
  }
  private async owned(row: SiteCdnRow, base: SiteSettingRow, c: CdnCredentials) {
    const result = await this.api.call(c, 'ListTagResources', {
      ResourceType: 'DOMAIN',
      'ResourceId.1': cdnDomain(base),
    });
    if (
      !(result.TagResources?.TagResource ?? []).some(
        (v: any) => v.TagKey === 'eat-instance' && v.TagValue === base.resourceKey,
      )
    )
      throw new CdnConflict('CDN 域名缺少本实例的归属标签，保留外部资源；请核对后重试');
  }
  private async detail(c: CdnCredentials, domain: string) {
    try {
      return (await this.api.call(c, 'DescribeCdnDomainDetail', { DomainName: domain })).GetDomainDetailModel;
    } catch (e) {
      if (
        e instanceof CdnApiError &&
        ['InvalidDomain.NotFound', 'InvalidDomainName.NotFound'].includes(e.code)
      )
        return null;
      throw e;
    }
  }
  private async enable(row: SiteCdnRow, base: SiteSettingRow, c: CdnCredentials, guard: () => void) {
    if (base.status !== 'enabled') throw new SiteSetupError('Folio 发布尚未启用；CDN 不改变 Folio 可用状态');
    if (
      normalized(base.gatewayTarget) === base.domain ||
      normalized(base.gatewayTarget).endsWith(`.${base.domain}`)
    )
      throw new SiteSetupError('源站地址必须独立于 Folio 泛域名，避免 DNS 切换后循环回源');
    await checkCdnOrigin(base, row.cname);
    guard();
    await this.phase(row, '检查 CDN 服务与权限', 'checking');
    await this.api.call(c, 'DescribeCdnService');
    guard();
    const domain = cdnDomain(base);
    let detail = await this.detail(c, domain);
    guard();
    if (!detail) {
      await this.phase(row, '域名归属验证');
      const content = String(
        (await this.api.call(c, 'DescribeVerifyContent', { DomainName: base.domain })).Content ?? '',
      );
      if (!/^verify_[a-zA-Z0-9]+$/.test(content)) throw new SiteSetupError('阿里云未返回有效的域名验证值');
      const root = getDomain(base.domain);
      if (!root) throw new SiteSetupError('无法确定注册域名');
      const name = `verification.${root}`;
      row.resources.verification ??= { name, value: content };
      if (row.resources.verification.value !== content)
        throw new CdnConflict('域名验证值被外部修改，请核对验证记录');
      await this.journal(row);
      await this.store.patch({ dnsInstructions: [{ name, type: 'TXT', value: content }] });
      if (row.autoDns) {
        const dns = await this.dns.connect(base);
        guard();
        if (!(name === dns.zone || name.endsWith(`.${dns.zone}`)))
          throw new SiteSetupError('DNS 凭证无权管理主域名的 verification TXT，请手动添加');
        const records = await dns.records(name);
        if (!records.some((r) => r.type === 'TXT' && r.content === content)) {
          if (records.length) throw new CdnConflict('域名验证 TXT 已存在不同值，保留外部记录');
          guard();
          row.resources.verification.id = await dns.add(name, 'TXT', content);
          await this.journal(row);
        }
      }
      try {
        const verification = await this.api.call(c, 'VerifyDomainOwner', {
          DomainName: base.domain,
          VerifyType: 'dnsCheck',
        });
        // The API can return HTTP 200 with Content when ownership is still unverified.
        if (verification.Content) throw new WaitDns('等待 TXT 域名验证生效，请按指引配置后重新检查');
      } catch (e) {
        if (e instanceof CdnApiError && e.code === 'DomainOwnerVerifyFail')
          throw new WaitDns('等待 TXT 域名验证生效，请按指引配置后重新检查');
        throw e;
      }
      row.dnsInstructions = [];
      await this.store.patch({ dnsInstructions: [] });
      await this.phase(row, '创建本实例的泛域名 CDN');
      row.resources.domain = domain;
      row.resources.creating = true;
      await this.journal(row);
      guard();
      await this.api.call(c, 'AddCdnDomain', {
        DomainName: domain,
        CdnType: 'web',
        Scope: row.scope,
        Sources: JSON.stringify([
          {
            content: base.gatewayTarget,
            type: isIP(base.gatewayTarget) ? 'ipaddr' : 'domain',
            port: 443,
            priority: '20',
            weight: '10',
          },
        ]),
        'Tag.1.Key': 'eat-instance',
        'Tag.1.Value': base.resourceKey,
      });
      detail = await this.detail(c, domain);
    }
    if (!detail) throw new SiteSetupError('等待 CDN 域名创建完成');
    await this.owned(row, base, c);
    guard();
    row.resources.owned = true;
    row.resources.creating = false;
    await this.journal(row);
    // Also remove stale verification guidance saved by older versions before creation succeeded.
    if (row.dnsInstructions.some((d) => d.type === 'TXT' && d.name === row.resources.verification?.name)) {
      row.dnsInstructions = row.dnsInstructions.filter(
        (d) => d.type !== 'TXT' || d.name !== row.resources.verification?.name,
      );
      await this.store.patch({ dnsInstructions: row.dnsInstructions });
    }
    const sources = detail.SourceModels?.SourceModel ?? [];
    if (
      detail.Scope !== row.scope ||
      sources.length !== 1 ||
      normalized(sources[0].Content ?? '') !== normalized(base.gatewayTarget) ||
      Number(sources[0].Port) !== 443
    )
      throw new CdnConflict('CDN 区域或源站与记录不符，保留现状，请核对外部修改');
    if (detail.DomainStatus === 'offline') {
      await this.api.call(c, 'StartCdnDomain', { DomainName: domain });
      throw new SiteSetupError('CDN 正在启动，稍后自动重试');
    }
    if (detail.DomainStatus !== 'online')
      throw new SiteSetupError('等待 CDN 域名审核、部署或 ICP 备案检查完成');
    const cname = normalized(detail.Cname ?? '');
    if (!/^[a-z0-9.-]+$/.test(cname) || !cname.includes('.'))
      throw new SiteSetupError('CDN 未返回有效的 CNAME');
    row.cname = cname;
    await this.store.patch({ cname });
    await checkCdnOrigin(base, cname);
    guard();
    await this.phase(row, '读取源站证书并同步 CDN HTTPS');
    guard();
    await this.syncCertificate(row, base, c);
    await this.phase(row, '配置 HTTPS 回源和源站缓存策略');
    let configs = cdnConfigsToCheck(await this.infra.configurations(c, domain));
    guard();
    const change = row.resources.certificateVerificationChange;
    if (
      (row.resources.configDigest || change) &&
      ![row.resources.configDigest, change?.from, change?.to].includes(configDigest(configs))
    )
      throw new CdnConflict('CDN 配置发生外部修改，已暂停自动覆盖，请恢复原配置后重试');
    configs = await this.certificateVerification(row, base, c, configs, guard);
    const functions = cdnFunctions(row, base);
    if (row.resources.cacheModel !== 'origin-v1') {
      // Only remove exact old EAT rules on our tagged domain. Persist intent before each API call;
      // a lost response/restart is safe because absence of an already deleted ConfigId is success.
      const legacy = legacyCdnFunctions(row, base);
      if (configs.some((v: any) => ![...functions, ...legacy].some(
        (f) => configDigest([f]) === configDigest([v]),
      ))) throw new CdnConflict('CDN 存在未知配置，无法安全迁移源站缓存策略，请核对后重试');
      const obsolete = configs.filter((v: any) => legacy.some(
        (f) => configDigest([f]) === configDigest([v]),
      ));
      if (obsolete.some((v: any) => !/^\d+$/.test(String(v.ConfigId))))
        throw new CdnConflict('CDN 旧规则缺少有效配置 ID，保留现状');
      row.resources.configured = false;
      row.resources.configDigest = undefined;
      row.resources.legacyConfigRemoval = obsolete.map((v: any) => ({
        id: String(v.ConfigId), digest: configDigest([v]),
      }));
      await this.journal(row);
      for (const rule of row.resources.legacyConfigRemoval) {
        guard();
        await this.phase(row, '迁移旧 CDN 规则为源站响应头控制缓存');
        await this.api.call(c, 'DeleteSpecificConfig', { DomainName: domain, ConfigId: rule.id });
        guard();
      }
      configs = cdnConfigsToCheck(await this.infra.configurations(c, domain));
      if (configs.some((v: any) => legacy.some((f) => configDigest([f]) === configDigest([v]))))
        throw new SiteSetupError('等待旧 CDN 规则删除下发，尚未切换 DNS');
      row.resources.legacyConfigRemoval = undefined;
      row.resources.cacheModel = 'origin-v1';
      await this.journal(row);
    }
    if (!row.resources.configured) {
      const missing = functions.filter(
        (f) => !configs.some((v: any) => configDigest([v]) === configDigest([f])),
      );
      if (configs.some((v: any) => !functions.some((f) => configDigest([f]) === configDigest([v]))))
        throw new CdnConflict('CDN 存在未知或不匹配的回源或缓存配置，保留现状，请核对后重试');
      for (const rule of missing) {
        guard();
        await this.phase(row, `配置 CDN 功能：${rule.functionName}`);
        const apply = () =>
          this.api.call(c, 'BatchSetCdnDomainConfig', {
            DomainNames: domain,
            Functions: JSON.stringify([rule]),
          });
        try {
          await apply();
        } catch (e) {
          if (
            rule.functionName !== 'origin_certificate_verification' ||
            !(e instanceof CdnApiError) ||
            e.code !== 'InvalidArgName.ValueNotSupported'
          )
            throw e;
          // Both names appear in current official documentation. Preserve the saved value.
          const alternate = rule.functionArgs[0].argName === 'enable' ? 'enabled' : 'enable';
          rule.functionArgs = [{ argName: alternate, argValue: row.verifyOriginCertificate ? 'on' : 'off' }];
          row.resources.certificateVerificationArg = alternate;
          await this.journal(row);
          guard();
          await apply();
        }
      }
      const actual = cdnConfigsToCheck(await this.infra.configurations(c, domain));
      if (actual.some((v: any) => v.Status !== 'success'))
        throw new SiteSetupError('等待 CDN 规则成功下发，尚未开放缓存或切换 DNS');
      if (configDigest(actual) !== configDigest(functions))
        throw new SiteSetupError('CDN 规则尚未全部同步，禁止切换 DNS');
      row.resources.configDigest = configDigest(actual);
      row.resources.configured = true;
      await this.journal(row);
    }
    if (
      cdnConfigsToCheck(await this.infra.configurations(c, domain)).some(
        (v: any) => v.Status !== 'success',
      ) ||
      (await this.detail(c, domain))?.DomainStatus !== 'online'
    )
      throw new SiteSetupError('等待 CDN 全网配置下发完成，尚未开放缓存或切换 DNS');
    await this.phase(row, '验证直连源站 HTTPS、Host/SNI 和 EAT 实例标记', 'verifying');
    await this.infra.verify(base, row, base.gatewayTarget, false);
    guard();
    await this.phase(row, '验证 CDN HTTPS、回源和公开静态缓存命中', 'verifying');
    await this.infra.verify(base, row, cname, true);
    guard();
    await this.store.patch({ certificateSyncedAt: new Date() });
    await this.phase(row, '切换 Folio 通配解析');
    await this.switchDns(row, base, true, guard);
    await this.exactDns(row, base, true, guard);
    guard();
    await this.phase(row, '验证 DNS 切换后的 CDN 实际访问', 'verifying');
    await this.infra.verify(base, row, `eat-cdn-${base.resourceKey.slice(0, 8)}.${base.domain}`, true);
    await this.store.patch({
      status: 'enabled',
      connected: true,
      certificateSyncedAt: new Date(),
      phase: 'CDN 已接入；公开及密码 Folio 静态资源可缓存',
      lastError: '',
      dnsInstructions: [],
      attempts: 0,
      retryAt: new Date(Date.now() + 3600_000),
      drainUntil: null,
    });
    if (!row.connected)
      await this.audit.record({
        actorId: row.actorId,
        action: 'site.cdn.enabled',
        targetType: 'site_cdn',
        targetId: '1',
      });
  }
  private async syncCertificate(row: SiteCdnRow, base: SiteSettingRow, c: CdnCredentials) {
    try {
      const cert = await this.infra.certificate(base);
      await this.store.patch({
        certificateExpiresAt: cert.expiresAt,
        originCertificateCheckedAt: new Date(),
      });
      if (cert.fingerprint !== row.resources.certificateFingerprint) {
        await this.api.call(c, 'SetCdnDomainSSLCertificate', {
          DomainName: cdnDomain(base),
          CertType: 'upload',
          CertName: `eat-${base.resourceKey}`,
          SSLProtocol: 'on',
          SSLPub: cert.pem,
          SSLPri: cert.key,
        });
        row.resources.certificateFingerprint = cert.fingerprint;
        await this.journal(row);
        await this.store.patch({ certificateSyncError: '' });
      }
      if (cert.expiresAt.getTime() < Date.now() + 21 * 86400_000)
        await this.store.patch({
          certificateSyncError: '源站证书将在 21 天内到期，请检查 Traefik ACME 续期；CDN 同步持续重试',
        });
    } catch (e) {
      await this.store.patch({
        certificateSyncError:
          e instanceof SiteSetupError || e instanceof CdnApiError
            ? e.message
            : '证书读取或同步失败，将自动重试',
      });
      throw e;
    }
  }
  private async switchDns(row: SiteCdnRow, base: SiteSettingRow, toCdn: boolean, guard: () => void) {
    const name = `*.${base.domain}`;
    const direct = {
      name,
      type: isIP(base.gatewayTarget) === 4 ? 'A' : isIP(base.gatewayTarget) === 6 ? 'AAAA' : 'CNAME',
      content: base.gatewayTarget,
      ttl: 600,
    };
    if (!row.autoDns) {
      const desired = toCdn
        ? { name, type: 'CNAME', value: row.cname }
        : { name, type: direct.type, value: direct.content };
      await this.store.patch({ dnsInstructions: [desired] });
      if (toCdn) {
        const { resolveCname } = await import('node:dns/promises');
        const cnames = await resolveCname(`eat-cdn-${base.resourceKey.slice(0, 8)}.${base.domain}`).catch(
          () => [],
        );
        if (!cnames.some((c) => normalized(c) === row.cname))
          throw new WaitDns('请添加 CNAME 后重新检查；精确 Folio 域名记录也需核对，不能覆盖外部记录');
      } else {
        try {
          await this.origin.checkDns(base);
        } catch {
          throw new WaitDns('请先按指引恢复源站解析，再重新检查');
        }
      }
      row.resources.dnsSwitched = toCdn;
      await this.journal(row);
      return;
    }
    const dns = await this.dns.connect(base);
    const records = await dns.records(name);
    guard();
    if (
      records.some(
        (r) =>
          r.proxied || (r.line && r.line !== 'default') || (r.status && r.status.toUpperCase() !== 'ENABLE'),
      )
    )
      throw new CdnConflict('DNS 包含代理、分线路或暂停记录，保留现状，请先人工整理');
    if (records.length > 1) throw new CdnConflict('存在多条通配解析，请先人工整理；EAT 保留现状');
    if (toCdn) {
      const managed = row.resources.managedDns;
      if (managed && records.length === 1 && sameRecord(records[0], managed)) {
        row.resources.dnsSwitched = true;
        await this.journal(row);
        return;
      }
      if (
        managed &&
        records.length === 1 &&
        ((row.resources.previousDns?.[0] && sameRecord(records[0], row.resources.previousDns[0])) ||
          (!managed.id && records[0].type === 'CNAME' && normalized(records[0].content) === row.cname))
      ) {
        managed.id = records[0].id;
        guard();
        await dns.update(managed);
        row.resources.dnsSwitched = true;
        await this.journal(row);
        return;
      }
      if (managed) throw new CdnConflict('Folio DNS 记录被外部修改，保留现状');
      if (
        records.length &&
        (records[0].type !== direct.type || normalized(records[0].content) !== normalized(direct.content))
      )
        throw new CdnConflict('已有 DNS 不是预期的 Folio 直连记录，保留现状');
      row.resources.previousDns = records.map((r) => ({ ...r, ttl: r.ttl ?? 600 }));
      // Intent written before the DNS side effect; update keeps the existing provider record ID.
      const next = { id: records[0]?.id ?? '', name, type: 'CNAME', content: row.cname, ttl: 600 };
      row.resources.managedDns = next;
      await this.journal(row);
      guard();
      if (next.id) await dns.update(next);
      else {
        next.id = await dns.add(name, 'CNAME', row.cname);
        await this.journal(row);
      }
      row.resources.dnsSwitched = true;
      await this.journal(row);
    } else if (row.resources.managedDns) {
      const managed = row.resources.managedDns;
      const previous = row.resources.previousDns?.[0];
      if (
        records.length === 1 &&
        (previous
          ? sameRecord(records[0], previous)
          : records[0].id === managed.id &&
            records[0].type === direct.type &&
            normalized(records[0].content) === normalized(direct.content))
      ) {
        row.resources.dnsSwitched = false;
        await this.journal(row);
        return;
      }
      if (records.length !== 1 || !sameRecord(records[0], managed))
        throw new CdnConflict('关闭前发现 DNS 外部修改，保留现状，请手动恢复');
      guard();
      // Preserve the working origin record even if the wildcard did not exist before onboarding.
      await dns.update(previous ?? { ...direct, id: managed.id });
      row.resources.dnsSwitched = false;
      await this.journal(row);
    }
  }
  /** Only known Folio hosts are eligible for adoption; other applications are never enumerated. */
  private async exactDns(row: SiteCdnRow, base: SiteSettingRow, toCdn: boolean, guard: () => void) {
    if (!row.autoDns) return;
    const dns = await this.dns.connect(base);
    guard();
    if (!row.resources.dnsNames && toCdn) {
      const versions = await this.store.settings.db
        .select({ slug: sites.slug, number: siteVersions.number })
        .from(sites)
        .leftJoin(siteVersions, eq(siteVersions.siteId, sites.id));
      row.resources.dnsNames = [
        ...new Set(
          versions.flatMap((v) => [
            `${v.slug}.${base.domain}`,
            ...(v.number ? [`v${v.number}--${v.slug}.${base.domain}`] : []),
          ]),
        ),
      ].sort();
      row.resources.dnsScanIndex = 0;
      await this.journal(row);
    }
    const reconcile = async (entry: NonNullable<SiteCdnRow['resources']['extraDns']>[number]) => {
      const records = await dns.records(entry.managed.name);
      guard();
      const desired = toCdn ? entry.managed : entry.previous;
      const prior = toCdn ? entry.previous : entry.managed;
      if (records.length === 1 && sameRecord(records[0], desired)) return;
      if (records.length !== 1 || !sameRecord(records[0], prior))
        throw new CdnConflict(`Folio 精确解析 ${entry.managed.name} 被外部修改，保留现状`);
      await dns.update(desired);
      guard();
    };
    for (const entry of row.resources.extraDns ?? []) await reconcile(entry);
    if (!toCdn) return;
    const names = row.resources.dnsNames ?? [];
    for (let i = row.resources.dnsScanIndex ?? 0; i < names.length; i++) {
      guard();
      const name = names[i];
      await this.phase(row, `核对现有 Folio 精确解析 ${i + 1}/${names.length}`);
      const recorded = row.resources.extraDns?.find((e) => e.managed.name === name);
      if (recorded) {
        await reconcile(recorded);
        row.resources.dnsScanIndex = i + 1;
        await this.journal(row);
        continue;
      }
      const records = await dns.records(name);
      guard();
      if (records.length) {
        const directType =
          isIP(base.gatewayTarget) === 4 ? 'A' : isIP(base.gatewayTarget) === 6 ? 'AAAA' : 'CNAME';
        if (
          records.length !== 1 ||
          records[0].type !== directType ||
          normalized(records[0].content) !== normalized(base.gatewayTarget) ||
          records[0].proxied ||
          (records[0].line && records[0].line !== 'default') ||
          (records[0].status && records[0].status.toUpperCase() !== 'ENABLE')
        )
          throw new CdnConflict(`Folio 精确解析 ${name} 不是预期的直连记录，保留现状`);
        const previous = { ...records[0], ttl: records[0].ttl ?? 600 };
        const entry = {
          previous,
          managed: { id: previous.id, name, type: 'CNAME', content: row.cname, ttl: 600 },
        };
        row.resources.extraDns ??= [];
        row.resources.extraDns.push(entry);
        await this.journal(row);
        await reconcile(entry);
      }
      row.resources.dnsScanIndex = i + 1;
      await this.journal(row);
    }
  }
  private async disable(row: SiteCdnRow, base: SiteSettingRow, c: CdnCredentials, guard: () => void) {
    await this.owned(row, base, c);
    guard();
    row.resources.owned = true;
    await this.journal(row);
    await this.phase(row, '恢复源站解析并验证访问', 'draining');
    await this.switchDns(row, base, false, guard);
    await this.exactDns(row, base, false, guard);
    await this.origin.checkDns(base);
    await this.infra.verify(base, row, base.gatewayTarget, false);
    guard();
    if (!row.resources.configured) row.drainUntil = new Date(0);
    if (!row.drainUntil) {
      // Keep edge TLS/authentication alive for old DNS answers and previously returned resource URLs.
      const ttl = Math.max(
        600,
        ...(row.resources.previousDns ?? []).map((r) => r.ttl),
        ...(row.resources.extraDns ?? []).map((r) => r.previous.ttl),
      );
      row.drainUntil = new Date(Date.now() + Math.max(24 * 3600, ttl * 2) * 1000);
      await this.store.patch({ drainUntil: row.drainUntil, connected: false });
    }
    if (Date.now() < row.drainUntil.getTime()) {
      await this.syncCertificate(row, base, c);
      await this.infra.verify(base, row, row.cname, true);
      await this.store.patch({
        certificateSyncedAt: new Date(),
        status: 'draining',
        phase: '源站已恢复；保留 CDN 至 DNS 传播等待期结束',
        retryAt: new Date(Date.now() + 60_000),
        lastError: '',
      });
      return;
    }
    await this.phase(row, 'DNS 传播等待期结束，停止本实例 CDN', 'draining');
    guard();
    let detail = await this.detail(c, cdnDomain(base));
    if (detail?.DomainStatus !== 'offline' && detail?.DomainStatus !== 'stopping') {
      await this.api.call(c, 'StopCdnDomain', { DomainName: cdnDomain(base) });
      detail = await this.detail(c, cdnDomain(base));
    }
    if (detail?.DomainStatus !== 'offline') {
      await this.store.patch({
        status: 'draining',
        phase: '源站已恢复，等待 CDN 停止完成',
        retryAt: new Date(Date.now() + 30_000),
      });
      return;
    }
    await this.store.patch({
      status: 'disabled',
      connected: false,
      phase: 'CDN 已停止，源站及证书保留',
      retryAt: null,
      dnsInstructions: [],
      lastError: '',
    });
    await this.audit.record({
      actorId: row.actorId,
      action: 'site.cdn.disabled',
      targetType: 'site_cdn',
      targetId: '1',
    });
  }
}
