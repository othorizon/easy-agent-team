import { Injectable } from '@nestjs/common';
import { and, inArray, isNull, lte, sql } from 'drizzle-orm';
import { siteCdnPurges } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { SiteCdnStore } from './site-cdn.store';
import { CdnApiError, SiteCdnClient } from './site-cdn.client';
import { SiteSetupError } from './site-dns.service';
import { parseSiteHost } from './site-config';
import { cdnDomain } from './site-cdn.infrastructure';

@Injectable()
export class SiteCdnPurgeService {
  constructor(
    private readonly store: SiteCdnStore,
    private readonly api: SiteCdnClient,
    private readonly audit: AuditService,
  ) {}

  /** Caller holds the shared PostgreSQL session lock, including across provider calls. */
  async tick(guard: () => void) {
    const db = this.store.settings.db;
    const row = await this.store.row();
    if (!row?.resources.owned || row.resources.cacheModel !== 'origin-v1' ||
        ['disabled', 'conflict'].includes(row.status)) return;
    const jobs = await db.select().from(siteCdnPurges).where(and(
      isNull(siteCdnPurges.completedAt), lte(siteCdnPurges.retryAt, new Date()),
    )).orderBy(siteCdnPurges.retryAt, siteCdnPurges.createdAt).limit(10);
    if (!jobs.length) return;
    const base = await this.store.settings.required();
    const credentials = this.store.credentials(row, base);
    // A batch contains at most ten concrete hosts; wildcard refresh URLs are unsupported.
    const first = jobs[0];
    const batch = jobs.filter((j) => JSON.stringify(j.taskIds) === JSON.stringify(first.taskIds));
    const ids = batch.map((j) => j.id);
    let resubmit = false;
    try {
      for (const job of batch) {
        const url = new URL(job.url);
        if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search ||
            url.hash || !parseSiteHost(url.hostname, base.domain) ||
            !/^\/__eat\/cdn\/[a-f0-9-]{36}\/$/.test(url.pathname))
          throw new SiteSetupError('缓存刷新目标与当前 Folio 域名不符，已暂停该任务');
      }
      const tags = await this.api.call(credentials, 'ListTagResources', {
        ResourceType: 'DOMAIN', 'ResourceId.1': cdnDomain(base),
      });
      if (!(tags.TagResources?.TagResource ?? []).some(
        (t: any) => t.TagKey === 'eat-instance' && t.TagValue === base.resourceKey,
      )) throw new SiteSetupError('缓存刷新无法确认本实例 CDN 资源归属');
      guard();
      if (!first.taskIds.length) {
        const result = await this.api.call(credentials, 'RefreshObjectCaches', {
          ObjectPath: [...new Set(batch.map((j) => j.url))].join('\n'), ObjectType: 'Directory', Force: 'true',
        });
        const taskIds = String(result.RefreshTaskId ?? '').split(',');
        if (!taskIds.length || taskIds.some((id) => !/^\d+$/.test(id)))
          throw new SiteSetupError('CDN 未返回有效的缓存刷新任务 ID');
        guard();
        await db.update(siteCdnPurges).set({ taskIds, submittedAt: new Date(),
          lastError: '', retryAt: new Date(Date.now() + 30_000) }).where(inArray(siteCdnPurges.id, ids));
        return;
      }
      // Tasks older than the provider's three-day query window are safely submitted again.
      if (!first.submittedAt || first.submittedAt.getTime() < Date.now() - 2 * 86400_000) {
        resubmit = true;
        throw new SiteSetupError('缓存刷新状态已超出查询窗口，将重新提交');
      }
      let complete = true;
      for (const taskId of first.taskIds) {
        for (let page = 1; ; page++) {
          guard();
          const result = await this.api.call(credentials, 'DescribeRefreshTasks', {
            TaskId: taskId, DomainName: cdnDomain(base), ObjectType: 'directory',
            PageSize: '100', PageNumber: String(page),
          });
          const tasks = result.Tasks?.CDNTask ?? [];
          if (tasks.some((t: any) => ['Failed', 'Timeout', 'Canceled'].includes(t.Status))) {
            resubmit = true;
            throw new SiteSetupError('CDN 缓存刷新失败，将重新提交；请检查配额与服务状态');
          }
          if (!tasks.length || tasks.some((t: any) => t.Status !== 'Complete')) complete = false;
          if (Number(result.TotalCount ?? tasks.length) <= page * 100) break;
          if (page >= 100) throw new SiteSetupError('CDN 刷新任务分页超限，将稍后重试');
        }
      }
      guard();
      await db.update(siteCdnPurges).set({
        completedAt: complete ? new Date() : null, lastError: '',
        retryAt: new Date(Date.now() + 30_000),
      }).where(inArray(siteCdnPurges.id, ids));
      if (complete) await this.audit.record({ actorId: row.actorId, action: 'site.cdn.cache_refreshed',
        targetType: 'site_cdn', targetId: '1', meta: { count: batch.length } });
      // Retain recent completion evidence without growing the outbox indefinitely.
      await db.delete(siteCdnPurges).where(sql`${siteCdnPurges.completedAt} < now() - interval '7 days'`);
    } catch (e) {
      guard();
      const lastError = e instanceof CdnApiError || e instanceof SiteSetupError
        ? e.message : 'CDN 缓存刷新暂时失败，将自动重试';
      await db.update(siteCdnPurges).set({
        taskIds: resubmit ? [] : first.taskIds,
        submittedAt: resubmit ? null : first.submittedAt, attempts: first.attempts + 1, lastError,
        retryAt: new Date(Date.now() + Math.min(3600_000, 30_000 * 2 ** Math.min(first.attempts, 7))),
      }).where(inArray(siteCdnPurges.id, ids));
      await this.audit.record({ actorId: row.actorId, action: 'site.cdn.cache_refresh_failed',
        targetType: 'site_cdn', targetId: '1', meta: { count: batch.length } });
    }
  }
}
