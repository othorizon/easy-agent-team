import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import type {
  CreateTemplateRequest,
  SetTemplateItemsRequest,
  TemplateInfo,
  TemplateItemInfo,
  UpdateTemplateRequest,
} from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.decorators';
import { DB, type Db } from '../db/db.module';
import { environments, mcpConfigs, roleTemplates, skills, templateItems, userTemplateSelections } from '../db/schema';

@Injectable()
export class TemplatesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async enrichItems(templateId: string): Promise<TemplateItemInfo[]> {
    const items = await this.db.select().from(templateItems).where(eq(templateItems.templateId, templateId));
    const out: TemplateItemInfo[] = [];
    for (const item of items) {
      let slug = '(已删除)';
      let name = '(已删除)';
      if (item.itemType === 'skill') {
        const [s] = await this.db.select({ slug: skills.slug, name: skills.name }).from(skills).where(eq(skills.id, item.itemId));
        if (s) ({ slug, name } = s);
      } else if (item.itemType === 'mcp_config') {
        const [m] = await this.db.select({ slug: mcpConfigs.slug, name: mcpConfigs.name }).from(mcpConfigs).where(eq(mcpConfigs.id, item.itemId));
        if (m) ({ slug, name } = m);
      } else {
        const [e] = await this.db.select({ slug: environments.slug, name: environments.name }).from(environments).where(eq(environments.id, item.itemId));
        if (e) ({ slug, name } = e);
      }
      out.push({ itemType: item.itemType, itemId: item.itemId, slug, name });
    }
    return out;
  }

  async list(user: AuthUser): Promise<TemplateInfo[]> {
    const rows = await this.db.select().from(roleTemplates).orderBy(asc(roleTemplates.createdAt));
    const selection = (
      await this.db.select().from(userTemplateSelections).where(eq(userTemplateSelections.userId, user.id)).limit(1)
    )[0];
    return Promise.all(
      rows.map(async (t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        items: await this.enrichItems(t.id),
        selectedByMe: selection?.templateId === t.id,
        createdAt: t.createdAt.toISOString(),
      })),
    );
  }

  async create(user: AuthUser, dto: CreateTemplateRequest) {
    const [row] = await this.db
      .insert(roleTemplates)
      .values({ name: dto.name, description: dto.description, createdBy: user.id })
      .returning();
    await this.audit.record({ actorId: user.id, action: 'template.created', targetType: 'role_template', targetId: row.id });
    return row;
  }

  async update(user: AuthUser, id: string, dto: UpdateTemplateRequest) {
    const [row] = await this.db
      .update(roleTemplates)
      .set({ ...(dto.name ? { name: dto.name } : {}), ...(dto.description !== undefined ? { description: dto.description } : {}) })
      .where(eq(roleTemplates.id, id))
      .returning();
    if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: '模板不存在' });
    await this.audit.record({ actorId: user.id, action: 'template.updated', targetType: 'role_template', targetId: id });
    return row;
  }

  async remove(user: AuthUser, id: string) {
    await this.db.delete(roleTemplates).where(eq(roleTemplates.id, id));
    await this.audit.record({ actorId: user.id, action: 'template.deleted', targetType: 'role_template', targetId: id });
    return { ok: true };
  }

  /** 全量替换条目；校验引用存在，避免脏引用 */
  async setItems(user: AuthUser, id: string, dto: SetTemplateItemsRequest) {
    const template = (await this.db.select().from(roleTemplates).where(eq(roleTemplates.id, id)).limit(1))[0];
    if (!template) throw new NotFoundException({ error: 'NOT_FOUND', message: '模板不存在' });
    for (const type of ['skill', 'mcp_config', 'environment'] as const) {
      const ids = dto.items.filter((i) => i.itemType === type).map((i) => i.itemId);
      if (ids.length === 0) continue;
      const table = type === 'skill' ? skills : type === 'mcp_config' ? mcpConfigs : environments;
      const found = await this.db.select({ id: table.id }).from(table).where(inArray(table.id, ids));
      if (found.length !== new Set(ids).size) {
        throw new BadRequestException({ error: 'NOT_FOUND', message: `存在无效的 ${type} 引用` });
      }
    }
    await this.db.delete(templateItems).where(eq(templateItems.templateId, id));
    if (dto.items.length > 0) {
      await this.db.insert(templateItems).values(dto.items.map((i) => ({ templateId: id, itemType: i.itemType, itemId: i.itemId })));
    }
    await this.audit.record({ actorId: user.id, action: 'template.items_set', targetType: 'role_template', targetId: id, meta: { count: dto.items.length } });
    return { ok: true };
  }

  async select(user: AuthUser, id: string) {
    const template = (await this.db.select().from(roleTemplates).where(eq(roleTemplates.id, id)).limit(1))[0];
    if (!template) throw new NotFoundException({ error: 'NOT_FOUND', message: '模板不存在' });
    await this.db
      .insert(userTemplateSelections)
      .values({ userId: user.id, templateId: id })
      .onConflictDoUpdate({ target: userTemplateSelections.userId, set: { templateId: id, selectedAt: new Date() } });
    await this.audit.record({ actorId: user.id, action: 'template.selected', targetType: 'role_template', targetId: id });
    return { ok: true };
  }

  async deselect(user: AuthUser) {
    await this.db.delete(userTemplateSelections).where(eq(userTemplateSelections.userId, user.id));
    return { ok: true };
  }
}
