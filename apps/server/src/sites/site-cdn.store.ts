import { ConflictException, Injectable } from '@nestjs/common';
import { eq, isNull, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { SiteCdnInfo, UpdateSiteCdn } from '@eat/shared';
import { siteCdn, siteCdnPurges, siteSettings, auditLogs } from '../db/schema';
import { decryptSecret, encryptSecret } from '../common/crypto';
import { SiteCdnClient } from './site-cdn.client';
import { SiteSettingsStore, setupBusy, type SiteSettingRow } from './site-settings.store';

export type SiteCdnRow = typeof siteCdn.$inferSelect;
@Injectable()
export class SiteCdnStore {
  constructor(
    readonly settings: SiteSettingsStore,
    private readonly api: SiteCdnClient,
  ) {}
  async row() {
    return (await this.settings.db.select().from(siteCdn).where(eq(siteCdn.id, 1)))[0];
  }
  credentials(r: SiteCdnRow, base: SiteSettingRow) {
    if (r.credentialSource === 'alidns') {
      if (base.tlsMode !== 'alidns') throw new ConflictException('当前 Folio 没有可复用的 AliDNS 凭证');
      const s = this.settings.secrets(base);
      return { accessKeyId: s.dnsAccessKeyId, accessKeySecret: s.dnsAccessKeySecret };
    }
    return {
      accessKeyId: r.accessKeyIdEncrypted ? decryptSecret(r.accessKeyIdEncrypted) : '',
      accessKeySecret: r.accessKeySecretEncrypted ? decryptSecret(r.accessKeySecretEncrypted) : '',
    };
  }
  async info(): Promise<SiteCdnInfo> {
    const r = await this.row();
    const summary = await this.settings.db.execute(sql`select
      count(*) filter (where completed_at is null)::int as pending,
      max(completed_at) as completed,
      (array_agg(last_error order by created_at desc) filter (where completed_at is null and last_error <> ''))[1] as error,
      min(retry_at) filter (where completed_at is null) as retry
      from site_cdn_purge`);
    const refresh = summary.rows[0];
    const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
    const key = r?.accessKeyIdEncrypted ? decryptSecret(r.accessKeyIdEncrypted) : '';
    return {
      enabled: r?.enabled ?? false,
      scope: r?.scope ?? 'global',
      credentialSource: r?.credentialSource ?? 'independent',
      autoDns: r?.autoDns ?? false,
      verifyOriginCertificate: r?.verifyOriginCertificate ?? false,
      status: r?.status ?? 'disabled',
      connected: r?.connected ?? false,
      cacheRefresh: {
        pending: Number(refresh?.pending ?? 0),
        lastCompletedAt: iso(refresh?.completed),
        lastError: String(refresh?.error ?? ''),
        retryAt: iso(refresh?.retry),
      },
      accessKeyIdMasked: key ? (key.length > 8 ? `${key.slice(0, 4)}****${key.slice(-4)}` : '****') : '',
      hasSecret: !!r?.accessKeySecretEncrypted,
      phase: r?.phase ?? '',
      lastError: r?.lastError ?? '',
      cname: r?.cname ?? '',
      dnsInstructions: r?.dnsInstructions ?? [],
      certificateExpiresAt: r?.certificateExpiresAt?.toISOString() ?? null,
      certificateUploaded: !!r?.resources.certificateFingerprint,
      originCertificateCheckedAt: r?.originCertificateCheckedAt?.toISOString() ?? null,
      certificateSyncedAt: r?.certificateSyncedAt?.toISOString() ?? null,
      certificateSyncError: r?.certificateSyncError ?? '',
      retryAt: r?.retryAt?.toISOString() ?? null,
      drainUntil: r?.drainUntil?.toISOString() ?? null,
      updatedAt: r?.updatedAt?.toISOString() ?? null,
    };
  }
  async patch(values: Partial<typeof siteCdn.$inferInsert>) {
    await this.settings.db
      .update(siteCdn)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(siteCdn.id, 1));
  }
  async save(dto: UpdateSiteCdn, actorId: string) {
    await this.settings.db.transaction(async (tx) => {
      // Shared with Folio setup and the reconciler. Reject a save while a cloud call is in flight.
      const lock = await tx.execute(sql`select pg_try_advisory_xact_lock(1950536502) as acquired`);
      if (!lock.rows[0]?.acquired) throw new ConflictException('Folio/CDN 正在处理操作，请稍后重试');
      const [base] = await tx.select().from(siteSettings).where(eq(siteSettings.id, 1)).for('update');
      if (!base || setupBusy(base.status)) throw new ConflictException('请先完成 Folio 配置');
      const [r] = await tx.select().from(siteCdn).where(eq(siteCdn.id, 1)).for('update');
      if (dto.enabled && base.status !== 'enabled') throw new ConflictException('请先检查并启用 Folio 发布');
      if (dto.credentialSource === 'alidns' && base.tlsMode !== 'alidns')
        throw new ConflictException('当前 Folio 没有可复用的 AliDNS 凭证');
      if (dto.autoDns && !['alidns', 'cloudflare'].includes(base.tlsMode))
        throw new ConflictException('自动管理 DNS 需要现有 AliDNS 或 Cloudflare 凭证');
      if (r?.resources.owned && dto.scope !== r.scope)
        throw new ConflictException('已有 CDN 资源不能直接切换加速区域，请保持原区域');
      const key = dto.accessKeyId ? encryptSecret(dto.accessKeyId) : r?.accessKeyIdEncrypted;
      const secret = dto.accessKeySecret ? encryptSecret(dto.accessKeySecret) : r?.accessKeySecretEncrypted;
      if (dto.enabled && dto.credentialSource === 'independent' && (!key || !secret))
        throw new ConflictException('请填写独立 RAM AccessKey');
      if (
        r?.resources.owned &&
        (dto.credentialSource !== r.credentialSource || dto.accessKeyId || dto.accessKeySecret)
      ) {
        const credentials =
          dto.credentialSource === 'alidns'
            ? (() => {
                const s = this.settings.secrets(base);
                return { accessKeyId: s.dnsAccessKeyId, accessKeySecret: s.dnsAccessKeySecret };
              })()
            : {
                accessKeyId: key ? decryptSecret(key) : '',
                accessKeySecret: secret ? decryptSecret(secret) : '',
              };
        try {
          const tags = await this.api.call(credentials, 'ListTagResources', {
            ResourceType: 'DOMAIN',
            'ResourceId.1': `.${base.domain}`,
          });
          if (
            !(tags.TagResources?.TagResource ?? []).some(
              (t: any) => t.TagKey === 'eat-instance' && t.TagValue === base.resourceKey,
            )
          )
            throw new Error();
          await this.api.call(credentials, 'DescribeCdnService');
        } catch {
          throw new ConflictException('新凭证无法验证本实例 CDN 资源归属，原凭证已保留');
        }
      }
      const verifyOriginCertificate = dto.verifyOriginCertificate ?? r?.verifyOriginCertificate ?? false;
      const values = {
        enabled: dto.enabled,
        scope: dto.scope,
        credentialSource: dto.credentialSource,
        autoDns: dto.autoDns,
        verifyOriginCertificate,
        accessKeyIdEncrypted: key,
        accessKeySecretEncrypted: secret,
        originSecretEncrypted: r?.originSecretEncrypted ?? encryptSecret(randomBytes(32).toString('hex')),
        status: dto.enabled
          ? ('checking' as const)
          : (r?.resources.owned || r?.resources.creating) && r?.status !== 'disabled'
            ? ('draining' as const)
            : ('disabled' as const),
        drainUntil: dto.enabled ? null : r?.drainUntil,
        ...(dto.enabled && r && !r.enabled
          ? { resources: { ...r.resources, dnsNames: undefined, dnsScanIndex: 0 } }
          : {}),
        phase: dto.enabled ? '等待后台检查' : '等待恢复源站解析',
        lastError: '',
        attempts: 0,
        retryAt: new Date(),
        actorId,
        updatedAt: new Date(),
      };
      if (r) await tx.update(siteCdn).set(values).where(eq(siteCdn.id, 1));
      else await tx.insert(siteCdn).values(values);
      await tx
        .update(siteCdnPurges)
        .set({ retryAt: new Date(), attempts: 0 })
        .where(isNull(siteCdnPurges.completedAt));
      await tx.insert(auditLogs).values({
        actorId,
        action: 'site.cdn.saved',
        targetType: 'site_cdn',
        targetId: '1',
        meta: {
          enabled: dto.enabled,
          scope: dto.scope,
          credentialSource: dto.credentialSource,
          autoDns: dto.autoDns,
          verifyOriginCertificate,
          credentialsChanged: !!(dto.accessKeyId || dto.accessKeySecret),
        },
      });
    });
    return this.info();
  }
  async retry(actorId: string) {
    const r = await this.row();
    if (!r) throw new ConflictException('请先保存 CDN 配置');
    // Uses the same locking and auditing path, preserving the encrypted credentials.
    return this.save(
      {
        enabled: r.enabled,
        scope: r.scope,
        credentialSource: r.credentialSource,
        autoDns: r.autoDns,
        verifyOriginCertificate: r.verifyOriginCertificate,
      },
      actorId,
    );
  }
}
