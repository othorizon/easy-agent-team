import { z } from 'zod';

/** 角色模板：管理员预定义的「能力套餐」，成员一键选用 */

export const templateItemTypeSchema = z.enum(['skill', 'mcp_config', 'environment']);
export type TemplateItemType = z.infer<typeof templateItemTypeSchema>;

export const createTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).default(''),
});
export type CreateTemplateRequest = z.infer<typeof createTemplateSchema>;

export const updateTemplateSchema = createTemplateSchema.partial();
export type UpdateTemplateRequest = z.infer<typeof updateTemplateSchema>;

/** 全量替换模板条目 */
export const setTemplateItemsSchema = z.object({
  items: z
    .array(z.object({ itemType: templateItemTypeSchema, itemId: z.string() }))
    .max(100),
});
export type SetTemplateItemsRequest = z.infer<typeof setTemplateItemsSchema>;

export const templateItemInfoSchema = z.object({
  itemType: templateItemTypeSchema,
  itemId: z.string(),
  slug: z.string(),
  name: z.string(),
});
export type TemplateItemInfo = z.infer<typeof templateItemInfoSchema>;

export const templateInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  items: z.array(templateItemInfoSchema),
  /** 当前用户是否选用了该模板 */
  selectedByMe: z.boolean(),
  createdAt: z.string(),
});
export type TemplateInfo = z.infer<typeof templateInfoSchema>;
