import { ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { SiteCapabilityInfo, SiteSettingsInfo, UpdateSiteSettings } from '@eat/shared';
import { DB, type Db } from '../db/db.module';
import { sites, siteSettings, siteCleanups } from '../db/schema';
import { decryptSecret, encryptSecret } from '../common/crypto';
import { loadConfig } from '../config';

export type SiteSettingRow = typeof siteSettings.$inferSelect;
export const setupBusy = (s: string) => ['checking', 'provisioning', 'verifying', 'disabling'].includes(s);
@Injectable()
export class SiteSettingsStore {
  constructor(@Inject(DB) readonly db: Db) {}
  async row() {
    return (await this.db.select().from(siteSettings).where(eq(siteSettings.id, 1)))[0];
  }
  async required() {
    const row = await this.row();
    if (!row) throw new ServiceUnavailableException('请管理员先在系统设置中配置 Folio');
    return row;
  }
  async capability(): Promise<SiteCapabilityInfo> {
    const r = await this.row();
    return { enabled: r?.status === 'enabled', status: r?.status ?? 'disabled', domain: r?.domain ?? '' };
  }
  async enabled() {
    const r = await this.required();
    if (r.status !== 'enabled')
      throw new ServiceUnavailableException({
        error: 'SITES_DISABLED',
        message: 'Folio 尚未启用，请管理员在系统设置中检查并启用',
      });
    return r;
  }
  secrets(r: SiteSettingRow) {
    return {
      ossAccessKeyId: decryptSecret(r.ossAccessKeyIdEncrypted),
      ossAccessKeySecret: decryptSecret(r.ossAccessKeySecretEncrypted),
      dnsAccessKeyId: r.dnsAccessKeyIdEncrypted ? decryptSecret(r.dnsAccessKeyIdEncrypted) : '',
      dnsAccessKeySecret: r.dnsAccessKeySecretEncrypted ? decryptSecret(r.dnsAccessKeySecretEncrypted) : '',
    };
  }
  async info(): Promise<SiteSettingsInfo> {
    const r = await this.row();
    const secrets = r ? this.secrets(r) : null;
    const mask = (s: string) => (s ? (s.length > 8 ? `${s.slice(0, 4)}****${s.slice(-4)}` : '****') : '');
    return {
      configured: !!r,
      enabled: r?.status === 'enabled',
      status: r?.status ?? 'disabled',
      domain: r?.domain ?? '',
      platformUrl: r ? r.platformUrl || loadConfig().publicUrl.replace(/\/$/, '') : '',
      ossRegion: r?.ossRegion ?? 'oss-cn-hangzhou',
      ossBucket: r?.ossBucket ?? '',
      ossAccessKeyIdMasked: mask(secrets?.ossAccessKeyId ?? ''),
      hasOssSecret: !!secrets?.ossAccessKeySecret,
      tlsMode: r?.tlsMode ?? 'alidns',
      acmeEmail: r?.acmeEmail ?? '',
      dnsAccessKeyIdMasked: mask(secrets?.dnsAccessKeyId ?? ''),
      hasDnsSecret: !!secrets?.dnsAccessKeySecret,
      certificateId: r?.certificateId ?? '',
      resolverName: r?.resolverName ?? '',
      platformApplicationId: r?.platformApplicationId ?? '',
      upstreamUrl: r?.upstreamUrl ?? '',
      upstreamPort: r?.upstreamPort ?? 3000,
      gatewayTarget: r?.gatewayTarget ?? '',
      autoDns: r?.autoDns ?? false,
      checks: r?.checks ?? [],
      lastError: r?.lastError ?? '',
      updatedAt: r?.updatedAt.toISOString() ?? null,
    };
  }
  async save(dto: UpdateSiteSettings) {
    const platform = new URL(dto.platformUrl || loadConfig().publicUrl).hostname.toLowerCase();
    if (platform === dto.domain || platform.endsWith(`.${dto.domain}`))
      throw new ConflictException('Folio 域名后缀不能覆盖 EAT 控制台域名');
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(1950536501)`);
      const [r] = await tx.select().from(siteSettings).where(eq(siteSettings.id, 1)).for('update');
      if (r && (setupBusy(r.status) || r.status === 'enabled' || r.routeConfigured))
        throw new ConflictException('请先停用 Folio，再修改配置');
      if (r && r.domain !== dto.domain && (await tx.select({ id: sites.id }).from(sites).limit(1)).length)
        throw new ConflictException('已有 Folio，不能修改域名后缀；历史版本和评论链接需要保留');
      if (
        r &&
        (r.ossBucket !== dto.ossBucket || r.ossRegion !== dto.ossRegion) &&
        ((await tx.select({ id: sites.id }).from(sites).limit(1)).length ||
          (await tx.select().from(siteCleanups).limit(1)).length)
      )
        throw new ConflictException('已有 Folio 或待清理资源，不能切换 Bucket 或地域；可更新访问凭证');
      const enc = (value: string | undefined, previous?: string | null) =>
        value ? encryptSecret(value) : (previous ?? encryptSecret(''));
      const { ossAccessKeyId, ossAccessKeySecret, dnsAccessKeyId, dnsAccessKeySecret, ...plain } = dto;
      const values = {
        ...plain,
        platformUrl: (dto.platformUrl || loadConfig().publicUrl).replace(/\/$/, ''),
        ossAccessKeyIdEncrypted: enc(ossAccessKeyId, r?.ossAccessKeyIdEncrypted),
        ossAccessKeySecretEncrypted: enc(ossAccessKeySecret, r?.ossAccessKeySecretEncrypted),
        dnsAccessKeyIdEncrypted: enc(dnsAccessKeyId, r?.tlsMode === dto.tlsMode ? r.dnsAccessKeyIdEncrypted : null),
        dnsAccessKeySecretEncrypted: enc(
          dnsAccessKeySecret,
          r?.tlsMode === dto.tlsMode ? r.dnsAccessKeySecretEncrypted : null,
        ),
        updatedAt: new Date(),
      };
      if (!decryptSecret(values.ossAccessKeyIdEncrypted) || !decryptSecret(values.ossAccessKeySecretEncrypted))
        throw new ConflictException('请填写 OSS 访问凭证');
      if (
        ['alidns', 'cloudflare'].includes(dto.tlsMode) &&
        (!decryptSecret(values.dnsAccessKeySecretEncrypted) ||
          (dto.tlsMode === 'alidns' && !decryptSecret(values.dnsAccessKeyIdEncrypted)))
      )
        throw new ConflictException('请填写 DNS 服务商凭证');
      if (r)
        await tx
          .update(siteSettings)
          .set({ ...values, checks: [], lastError: '', status: 'disabled' })
          .where(eq(siteSettings.id, 1));
      else await tx.insert(siteSettings).values(values);
    });
    return this.info();
  }
}
