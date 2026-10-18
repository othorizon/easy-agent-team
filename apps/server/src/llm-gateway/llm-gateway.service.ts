import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { LlmGatewayInfo, LlmKeyInfo, LlmUsagePage } from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import { DB, PG_POOL, type Db } from '../db/db.module';
import {
  llmGatewayKeys as keys,
  llmGatewayOperations as ops,
  llmGatewayUsers as policies,
  users,
} from '../db/schema';
import { LLM_SETTINGS_LOCK, LlmSettingsService } from './llm-settings.service';
import { NewApiClient, NewApiError, type NewApiToken } from './newapi.client';

type KeyRow = typeof keys.$inferSelect;
type Operation = typeof ops.$inferSelect;
type Policy = typeof policies.$inferSelect;
type Kind = 'create' | 'status' | 'delete' | 'quota' | 'policy' | 'reconcile';

@Injectable()
export class LlmGatewayService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;
  private reconcileCursor = 0;
  private readonly lockPool: Pool;
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly settings: LlmSettingsService,
    private readonly audit: AuditService,
  ) {
    // Session locks must not consume every connection needed by the Drizzle queries below.
    this.lockPool = new Pool({ ...pool.options, max: 5 });
    this.lockPool.on('error', () => undefined);
  }
  onModuleInit() {
    this.timer = setInterval(() => void this.sweep().catch(() => undefined), 30_000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.lockPool.end();
  }

  private async lock<T>(userId: string, action: () => Promise<T>): Promise<T> {
    const connection = await this.lockPool.connect();
    try {
      await connection.query('select pg_advisory_lock_shared($1)', [LLM_SETTINGS_LOCK]);
      const r = await connection.query('select pg_try_advisory_lock(hashtextextended($1, 0)) as ok', [
        'llm:' + userId,
      ]);
      if (!r.rows[0].ok)
        throw new ConflictException({ error: 'LLM_BUSY', message: '该用户的网关操作正在执行，请稍后重试' });
      return await action();
    } finally {
      await connection.query('select pg_advisory_unlock(hashtextextended($1, 0))', ['llm:' + userId]);
      await connection.query('select pg_advisory_unlock_shared($1)', [LLM_SETTINGS_LOCK]);
      connection.release();
    }
  }
  private async policy(userId: string): Promise<Policy> {
    await this.db.insert(policies).values({ userId }).onConflictDoNothing();
    return (await this.db.select().from(policies).where(eq(policies.userId, userId)))[0];
  }
  private async allKeys(userId: string) {
    return this.db.select().from(keys).where(eq(keys.userId, userId)).orderBy(asc(keys.createdAt));
  }
  private async person(userId: string) {
    const row = (await this.db.select().from(users).where(eq(users.id, userId)))[0];
    if (!row) throw new NotFoundException('用户不存在');
    return row;
  }
  private async remember(row: KeyRow, token: NewApiToken) {
    if (![token.remain_quota, token.used_quota].every(Number.isSafeInteger))
      throw new NewApiError('New API 返回的额度超出有效范围');
    const raw = token.key.replace(/^sk-/, '');
    const masked = raw.includes('*')
      ? raw
      : raw.length > 8
        ? `${raw.slice(0, 4)}********${raw.slice(-4)}`
        : '********';
    const [updated] = await this.db
      .update(keys)
      .set({
        upstreamId: token.id,
        maskedKey: masked,
        upstreamStatus: token.status,
        remainingQuota: token.remain_quota,
        usedQuota: token.used_quota,
        // A delayed read must never restore a key that another operation has already retired.
        state: sql`case when ${keys.state} = 'creating' then 'current' else ${keys.state} end`,
        lastError: null,
        syncedAt: new Date(),
      })
      .where(eq(keys.id, row.id))
      .returning();
    return updated;
  }
  private async refresh(userId: string, client: NewApiClient) {
    const list = await this.allKeys(userId);
    for (const key of list) {
      if (!key.upstreamId) continue;
      try {
        await this.remember(key, await client.token(key.upstreamId));
      } catch (e) {
        await this.db
          .update(keys)
          .set({
            lastError:
              e instanceof NewApiError && e.missing
                ? 'New API 中的 Key 已被外部删除'
                : '无法同步 New API 额度',
          })
          .where(eq(keys.id, key.id));
        throw e;
      }
    }
    return this.allKeys(userId);
  }
  private used(list: KeyRow[]) {
    return list.reduce((n, key) => n + key.usedQuota, 0);
  }
  private assertQuota(value: number) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new BadRequestException('额度不能为负数或超过安全整数范围');
  }

  async info(userId: string, refresh = true): Promise<LlmGatewayInfo> {
    const user = await this.person(userId);
    const settings = await this.settings.row();
    const policy = (await this.db.select().from(policies).where(eq(policies.userId, userId)))[0];
    let error: string | null = null;
    if (settings && refresh) {
      try {
        await this.refresh(userId, (await this.settings.configured()).client);
      } catch (e) {
        error = e instanceof Error ? e.message : '无法刷新额度';
      }
    }
    const list = await this.allKeys(userId);
    const current = list.find((r) => r.state !== 'retired');
    const usedQuota = this.used(list);
    const pending = (
      await this.db
        .select()
        .from(ops)
        .where(and(eq(ops.userId, userId), eq(ops.state, 'pending')))
        .orderBy(desc(ops.createdAt))
        .limit(1)
    )[0];
    const latest = (
      await this.db.select().from(ops).where(eq(ops.userId, userId)).orderBy(desc(ops.createdAt)).limit(1)
    )[0];
    const issue = pending ?? (latest?.state === 'failed' ? latest : undefined);
    const remainingQuota =
      current && current.state !== 'creating'
        ? current.remainingQuota
        : policy?.giftClaimed
          ? Math.max(0, policy.allocatedQuota - usedQuota)
          : 0;
    let key: LlmKeyInfo | null = null;
    if (current) {
      const status =
        current.state === 'creating'
          ? 'creating'
          : current.lastError?.includes('外部删除')
            ? 'missing'
            : current.upstreamStatus === 2
              ? 'disabled'
              : current.upstreamStatus === 3
                ? 'expired'
                : current.upstreamStatus === 4 || current.remainingQuota <= 0
                  ? 'exhausted'
                  : 'active';
      key = {
        id: current.id,
        maskedKey: current.maskedKey ? `sk-${current.maskedKey.replace(/^sk-/, '')}` : '',
        status: pending?.kind === 'delete' && pending.state === 'pending' ? 'deleting' : status,
        createdAt: current.createdAt.toISOString(),
      };
    }
    const dates = list.map((r) => r.syncedAt?.getTime() ?? 0);
    return {
      configured: !!settings,
      userId,
      userName: user.name,
      userStatus: user.status,
      disabled: !!policy?.disabled,
      initialQuota: policy?.initialQuota ?? null,
      initialQuotaEffective: policy?.initialQuota ?? settings?.defaultQuota ?? 0,
      giftClaimed: !!policy?.giftClaimed,
      key,
      totalQuota: policy?.giftClaimed ? usedQuota + remainingQuota : 0,
      usedQuota,
      remainingQuota,
      currency: settings?.currency ?? null,
      apiBaseUrl: settings ? `${settings.apiUrl}/v1` : '',
      updatedAt: Math.max(...dates, 0) ? new Date(Math.max(...dates)).toISOString() : null,
      pending: !!pending,
      error: error ?? issue?.lastError ?? current?.lastError ?? null,
    };
  }
  async list() {
    const people = await this.db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt));
    const result: LlmGatewayInfo[] = [];
    let syncError: string | null = null;
    // One public-account page, not one network call per person.
    const config = await this.settings.row();
    try {
      if (config) {
        const client = (await this.settings.configured()).client;
        const owned = await this.db.select().from(keys).where(ne(keys.state, 'creating'));
        const byId = new Map(owned.map((row) => [row.upstreamId, row]));
        for (let page = 1; byId.size; page++) {
          const data = await client.tokens(page);
          for (const token of data.items) {
            const row = byId.get(token.id);
            if (row) {
              await this.remember(row, token);
              byId.delete(token.id);
            }
          }
          if (page * 100 >= data.total || !data.items.length) break;
        }
      }
    } catch (e) {
      syncError = e instanceof Error ? e.message : '无法刷新 New API 额度';
    }
    for (const user of people) {
      const info = await this.info(user.id, false);
      if (syncError && info.giftClaimed) info.error = info.error ?? syncError;
      result.push(info);
    }
    return result;
  }

  async operate(
    userId: string,
    actorId: string,
    kind: Kind,
    requestId: string,
    payload: Record<string, unknown> = {},
  ) {
    return this.lock(userId, async () => {
      await this.person(userId);
      await this.settings.configured();
      const previous = (await this.db.select().from(ops).where(eq(ops.id, requestId)))[0];
      if (previous) {
        const same =
          previous.userId === userId &&
          previous.actorId === actorId &&
          previous.kind === kind &&
          Object.keys({ ...previous.payload, ...payload }).every(
            (k) => JSON.stringify(previous.payload[k]) === JSON.stringify(payload[k]),
          );
        if (!same) throw new ConflictException('操作标识已被其他请求使用');
        if (previous.state === 'done') return this.info(userId);
      }
      const blocked = await this.db
        .select()
        .from(ops)
        .where(and(eq(ops.userId, userId), eq(ops.state, 'pending'), ne(ops.id, requestId)))
        .limit(1);
      if (blocked.length && !(kind === 'policy' && payload.disabled !== undefined))
        throw new ConflictException('之前的操作结果仍在确认中，请先重试或等待同步');
      const policy = await this.policy(userId);
      const user = await this.person(userId);
      if (['create', 'status'].includes(kind) && (policy.disabled || user.status !== 'active'))
        throw new ForbiddenException('网关权限已被管理员禁用');
      if (!previous) await this.db.insert(ops).values({ id: requestId, userId, actorId, kind, payload });
      await this.execute((await this.db.select().from(ops).where(eq(ops.id, requestId)))[0]);
      return this.info(userId);
    });
  }

  private async execute(op: Operation) {
    const { row: settings, client } = await this.settings.configured();
    try {
      const person = await this.person(op.userId);
      let policy = await this.policy(op.userId);
      // Local access intent must survive an upstream outage; quota changes additionally need a fresh balance.
      let list = op.kind === 'quota' ? await this.refresh(op.userId, client) : await this.allKeys(op.userId);
      let current = list.find((r) => r.state !== 'retired');
      if (!op.applied) {
        if (op.kind === 'status' && !current) throw new BadRequestException('请先申请 API Key');
        await this.db.transaction(async (tx) => {
          if (op.kind === 'policy') {
            if (op.payload.initialQuota !== undefined && policy.giftClaimed)
              throw new BadRequestException('已申请用户请使用额度调整，不再修改首次赠送');
            await tx
              .update(policies)
              .set({
                ...(op.payload.initialQuota !== undefined
                  ? { initialQuota: op.payload.initialQuota as number | null }
                  : {}),
                ...(op.payload.disabled !== undefined ? { disabled: op.payload.disabled as boolean } : {}),
                updatedAt: new Date(),
              })
              .where(eq(policies.userId, op.userId));
          }
          if (op.kind === 'status')
            await tx
              .update(policies)
              .set({ userEnabled: op.payload.enabled === true, updatedAt: new Date() })
              .where(eq(policies.userId, op.userId));
          if (op.kind === 'quota') {
            if (!policy.giftClaimed) throw new BadRequestException('尚未申请 Key，请配置首次申请赠送额度');
            const remaining = current?.remainingQuota ?? Math.max(0, policy.allocatedQuota - this.used(list));
            const value = op.payload.quota as number;
            const target =
              op.payload.mode === 'add'
                ? remaining + value
                : op.payload.mode === 'subtract'
                  ? remaining - value
                  : value;
            this.assertQuota(target);
            this.assertQuota(this.used(list) + target);
            await tx
              .update(policies)
              .set({ allocatedQuota: this.used(list) + target, updatedAt: new Date() })
              .where(eq(policies.userId, op.userId));
          }
          if (op.kind === 'create' && !current) {
            if (!policy.giftClaimed) {
              await tx
                .update(policies)
                .set({ giftClaimed: true, allocatedQuota: policy.initialQuota ?? settings.defaultQuota })
                .where(eq(policies.userId, op.userId));
            }
            const id = randomUUID();
            await tx
              .insert(keys)
              .values({ id, userId: op.userId, upstreamName: `eat-${id}`, state: 'creating' });
          }
          await tx
            .update(ops)
            .set({ applied: true, state: 'pending', updatedAt: new Date() })
            .where(eq(ops.id, op.id));
        });
      }
      policy = await this.policy(op.userId);
      list = await this.refresh(op.userId, client);
      current = list.find((r) => r.state !== 'retired');
      if (current?.state === 'creating') {
        let token = await client.findToken(current.upstreamName);
        if (!token) {
          if (policy.disabled || person.status !== 'active')
            throw new ConflictException('账户已禁用，正在确认先前的申请');
          if (current.creationAttempted)
            throw new NewApiError('创建请求已发送，正在确认 New API 结果；不会重复创建', true);
          await this.db.update(keys).set({ creationAttempted: true }).where(eq(keys.id, current.id));
          try {
            await client.createToken(
              current.upstreamName,
              Math.max(0, policy.allocatedQuota - this.used(list)),
            );
          } catch (e) {
            if (e instanceof NewApiError && !e.uncertain)
              await this.db.update(keys).set({ creationAttempted: false }).where(eq(keys.id, current.id));
            throw e;
          }
          token = await client.findToken(current.upstreamName);
          if (!token) throw new NewApiError('Key 已创建，正在确认编号', true);
        }
        current = await this.remember(current, token);
        list = await this.allKeys(op.userId);
      }
      if (op.kind === 'delete' && current?.upstreamId) {
        await client.status(current.upstreamId, false);
        await this.remember(current, await client.token(current.upstreamId));
        // Keep an upstream disabled tombstone: late settlements/refunds still belong to this user's budget.
        await this.db.update(keys).set({ state: 'retired', maskedKey: '' }).where(eq(keys.id, current.id));
        current = undefined;
      }
      if (current?.upstreamId) {
        if (op.kind === 'quota') {
          const token = await client.token(current.upstreamId);
          await this.remember(current, token);
          list = await this.allKeys(op.userId);
          await client.setQuota(token, Math.max(0, policy.allocatedQuota - this.used(list)));
        }
        const enabled =
          !policy.disabled && (await this.person(op.userId)).status === 'active' && policy.userEnabled;
        const token = await client.token(current.upstreamId);
        if (
          (!enabled && token.status !== 2) ||
          (enabled && token.status !== 1 && token.remain_quota > 0 && token.expired_time === -1)
        ) {
          await client.status(current.upstreamId, enabled);
        }
        await this.remember(current, await client.token(current.upstreamId));
      }
      await this.db
        .update(ops)
        .set({ state: 'done', lastError: null, attempts: sql`${ops.attempts} + 1`, updatedAt: new Date() })
        .where(eq(ops.id, op.id));
      await this.audit.record({
        actorId: op.actorId,
        action: `llm.${op.kind}`,
        targetType: 'llm_gateway_user',
        targetId: op.userId,
        meta: { requestId: op.id, ...op.payload },
      });
    } catch (e) {
      const retry = !(e instanceof BadRequestException || e instanceof ForbiddenException);
      await this.db
        .update(ops)
        .set({
          state: retry ? 'pending' : 'failed',
          lastError: e instanceof Error ? e.message : '网关操作失败',
          attempts: sql`${ops.attempts} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(ops.id, op.id));
      if (!retry) throw e;
    }
  }

  async reveal(userId: string, actorId: string) {
    const info = await this.info(userId, false);
    if (info.disabled || (await this.person(userId)).status !== 'active')
      throw new ForbiddenException('网关权限已禁用');
    const current = (await this.allKeys(userId)).find((r) => r.state === 'current');
    if (!current?.upstreamId) throw new NotFoundException('请先申请 API Key');
    await this.audit.record({
      actorId,
      action: 'llm.key.read',
      targetType: 'llm_gateway_key',
      targetId: current.id,
    });
    const { client } = await this.settings.configured();
    return { key: await client.key(current.upstreamId), apiBaseUrl: info.apiBaseUrl };
  }
  async models(userId: string) {
    const { client } = await this.settings.configured();
    const current = (await this.allKeys(userId)).find((r) => r.state === 'current');
    // Disabled/exhausted keys cannot call /v1/models; the account catalogue remains useful for inspection.
    return client.models(
      current && current.upstreamStatus === 1 && current.remainingQuota > 0
        ? (current.upstreamId ?? undefined)
        : undefined,
    );
  }
  async usage(userId: string, page: number, pageSize: number, keyId?: string): Promise<LlmUsagePage> {
    const { client } = await this.settings.configured();
    const owned = await this.allKeys(userId);
    const selected = keyId
      ? owned.find((r) => r.id === keyId)
      : ([...owned].reverse().find((r) => r.state === 'current') ?? owned.at(-1));
    if (keyId && !selected) throw new NotFoundException('Key 不存在');
    if (!selected) return { items: [], page, pageSize, total: 0 };
    return client.logs(selected.upstreamName, page, pageSize);
  }
  async history(userId: string) {
    return (await this.allKeys(userId)).map((r) => ({
      id: r.id,
      state: r.state,
      createdAt: r.createdAt.toISOString(),
      usedQuota: r.usedQuota,
    }));
  }
  async retry(userId: string) {
    return this.lock(userId, async () => {
      const op = (
        await this.db
          .select()
          .from(ops)
          .where(and(eq(ops.userId, userId), eq(ops.state, 'pending')))
          .orderBy(asc(ops.createdAt))
          .limit(1)
      )[0];
      if (op) await this.execute(op);
      return this.info(userId);
    });
  }
  async onUserStatusChanged(userId: string, actorId: string) {
    if (!(await this.settings.row()) || !(await this.allKeys(userId)).length) return false;
    // Persist first; a failed upstream call must still be retried after EAT tokens have been revoked.
    const [op] = await this.db
      .insert(ops)
      .values({ id: randomUUID(), userId, actorId, kind: 'reconcile', payload: {} })
      .returning();
    try {
      await this.lock(userId, () => this.execute(op));
    } catch {
      /* persisted reconciliation survives busy locks and restarts */
    }
    const latest = (await this.db.select().from(ops).where(eq(ops.id, op.id)))[0];
    return latest.state !== 'done';
  }
  async sweep() {
    if (this.sweeping || !(await this.settings.row())) return;
    this.sweeping = true;
    try {
      const pending = await this.db
        .select()
        .from(ops)
        .where(eq(ops.state, 'pending'))
        .orderBy(asc(ops.updatedAt))
        .limit(20);
      for (const op of pending) {
        try {
          await this.lock(op.userId, () => this.execute(op));
        } catch {
          /* another worker owns the user */
        }
      }
      const owners = await this.db
        .selectDistinct({ userId: keys.userId })
        .from(keys)
        .where(eq(keys.state, 'retired'))
        .orderBy(asc(keys.userId));
      // Reconcile late usage on retired keys; the next allocation subtracts lifetime usage, never re-grants it.
      if (this.reconcileCursor >= owners.length) this.reconcileCursor = 0;
      const batch = owners.slice(this.reconcileCursor, this.reconcileCursor + 20);
      this.reconcileCursor += batch.length;
      for (const owner of batch) {
        try {
          await this.lock(owner.userId, async () => {
            const { client } = await this.settings.configured();
            const list = await this.refresh(owner.userId, client);
            const policy = await this.policy(owner.userId);
            const current = list.find((r) => r.state === 'current');
            if (current?.upstreamId && !current.lastError) {
              const desired = Math.max(0, policy.allocatedQuota - this.used(list));
              if (desired !== current.remainingQuota) {
                await client.setQuota(await client.token(current.upstreamId), desired);
                await this.remember(current, await client.token(current.upstreamId));
              }
            }
          });
        } catch {
          /* live upstream balances may be temporarily unavailable */
        }
      }
    } finally {
      this.sweeping = false;
    }
  }
}
