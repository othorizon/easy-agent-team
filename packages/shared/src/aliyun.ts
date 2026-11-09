import { z } from 'zod';

export const aliyunConnectionNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/, '接入名称只允许小写字母、数字和连字符');
const connectionFields = {
  name: aliyunConnectionNameSchema,
  defaultRegion: z.string().trim().max(100).default(''),
};
export const createAliyunConnectionSchema = z.object({
  ...connectionFields,
  accessKeyId: z.string().trim().min(1).max(256),
  accessKeySecret: z.string().trim().min(1).max(256),
});
export const updateAliyunConnectionSchema = z
  .object({
    ...connectionFields,
    accessKeyId: z.string().trim().max(256).default(''),
    accessKeySecret: z.string().trim().max(256).default(''),
  })
  .refine((v) => !!v.accessKeyId === !!v.accessKeySecret, {
    message: '更换管理凭证时需同时填写 AccessKey ID 和 Secret',
    path: ['accessKeySecret'],
  });
export const aliyunConnectionInfoSchema = z.object({
  id: z.string().uuid(),
  name: aliyunConnectionNameSchema,
  accountId: z.string(),
  defaultRegion: z.string(),
  status: z.enum(['enabled', 'paused']),
  accessKeyIdMasked: z.literal('********'),
  accessKeySecretMasked: z.literal('********'),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const aliyunConnectionsSchema = z.array(aliyunConnectionInfoSchema);
export const aliyunAvailabilitySchema = z.object({ available: z.boolean() });
export const aliyunConnectionStatusSchema = z.object({
  status: z.enum(['enabled', 'paused']),
});
export const aliyunConnectionValidationSchema = z.object({
  accountId: z.string(),
});
export const aliyunDeleteResultSchema = z.object({ ok: z.literal(true) });
export type CreateAliyunConnectionRequest = z.infer<
  typeof createAliyunConnectionSchema
>;
export type UpdateAliyunConnectionRequest = z.infer<
  typeof updateAliyunConnectionSchema
>;
export type AliyunConnectionInfo = z.infer<typeof aliyunConnectionInfoSchema>;
export type AliyunAvailability = z.infer<typeof aliyunAvailabilitySchema>;

export const aliyunPermissionInfoSchema = z.object({
  id: z.string().uuid(),
  connectionId: z.string().uuid(),
  policyName: z.string(),
  description: z.string(),
  cloudExists: z.boolean(),
  open: z.boolean(),
  purpose: z.string(),
  dataScope: z.string(),
  ownerId: z.string().uuid().nullable(),
  discoveredAt: z.string(),
  updatedAt: z.string(),
});
export const aliyunPermissionsSchema = z.array(aliyunPermissionInfoSchema);
export type AliyunPermissionInfo = z.infer<typeof aliyunPermissionInfoSchema>;
