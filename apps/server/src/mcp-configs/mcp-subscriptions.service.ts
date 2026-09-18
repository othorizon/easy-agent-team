import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { mcpSubscriptions, templateItems, userTemplateSelections } from '../db/schema';

/** 当前用户在各个配置上的订阅关系（一次查完，避免逐行查） */
export interface SubscriptionSets {
  approved: Set<string>;
  pending: Set<string>;
  rejected: Set<string>;
  /** 角色模板派生（没有订阅行，选了模板即生效） */
  template: Set<string>;
  /** 真正进入 sync 范围的集合 */
  effective: Set<string>;
}

/**
 * 「谁对哪个 MCP 配置有效订阅」的唯一判定处。
 *
 * 单独成一个服务是因为 McpConfigsService 与 McpGatewayService 都要用它，
 * 而两者本身是 configs → gateway 的单向依赖——判定逻辑留在 configs 里会绕成环。
 * 更重要的是：**授权判定只能有一份实现**，网关自己照抄一份迟早和这边算得不一样。
 */
@Injectable()
export class McpSubscriptionsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async sets(userId: string): Promise<SubscriptionSets> {
    const rows = await this.db
      .select({
        configId: mcpSubscriptions.configId,
        status: mcpSubscriptions.status,
        excluded: mcpSubscriptions.excluded,
      })
      .from(mcpSubscriptions)
      .where(eq(mcpSubscriptions.userId, userId));
    const pick = (status: (typeof rows)[number]['status']) =>
      new Set(rows.filter((r) => !r.excluded && r.status === status).map((r) => r.configId));
    const approved = pick('approved');
    const pending = pick('pending');
    const rejected = pick('rejected');
    const excluded = new Set(rows.filter((r) => r.excluded).map((r) => r.configId));
    const template = new Set(
      (
        await this.db
          .select({ itemId: templateItems.itemId })
          .from(userTemplateSelections)
          .innerJoin(templateItems, eq(userTemplateSelections.templateId, templateItems.templateId))
          .where(and(eq(userTemplateSelections.userId, userId), eq(templateItems.itemType, 'mcp_config')))
      ).map((r) => r.itemId),
    );
    const effective = new Set(approved);
    for (const id of template) if (!excluded.has(id)) effective.add(id);
    return { approved, pending, rejected, template, effective };
  }

  /** 网关每次请求都要问一遍的那个问题 */
  async isEffective(userId: string, configId: string): Promise<boolean> {
    return (await this.sets(userId)).effective.has(configId);
  }
}
