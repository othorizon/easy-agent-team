import { z } from 'zod';

/** 平台 AI 接入配置（OpenAI 接口范式，管理员维护） */
export const updateAiSettingsSchema = z.object({
  apiBaseUrl: z.url().max(500),
  /** 传空字符串表示保持现有 key 不变 */
  apiKey: z.string().max(500),
  model: z.string().min(1).max(200),
  enabled: z.boolean(),
});
export type UpdateAiSettingsRequest = z.infer<typeof updateAiSettingsSchema>;

/** 连通性测试：用表单当前值发起最小对话调用；apiKey 传空表示用已保存的 key */
export const testAiSettingsSchema = updateAiSettingsSchema.omit({ enabled: true });
export type TestAiSettingsRequest = z.infer<typeof testAiSettingsSchema>;

export const aiSettingsInfoSchema = z.object({
  apiBaseUrl: z.string(),
  /** 打码显示（sk-****abcd），永不返回明文 */
  apiKeyMasked: z.string(),
  model: z.string(),
  enabled: z.boolean(),
  configured: z.boolean(),
});
export type AiSettingsInfo = z.infer<typeof aiSettingsInfoSchema>;
