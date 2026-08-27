import { Inject, Injectable } from '@nestjs/common';
import { DB, type Db } from '../db/db.module';
import { auditLogs } from '../db/schema';

export interface AuditEntry {
  actorId?: string | null;
  actorTokenId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  meta?: Record<string, unknown>;
  ip?: string;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 审计写入失败不应影响业务，但敏感读取（secret.read）除外——由调用方 await 保证落库 */
  async record(entry: AuditEntry): Promise<void> {
    await this.db.insert(auditLogs).values({
      actorId: entry.actorId ?? null,
      actorTokenId: entry.actorTokenId ?? null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      meta: entry.meta,
      ip: entry.ip,
    });
  }
}
