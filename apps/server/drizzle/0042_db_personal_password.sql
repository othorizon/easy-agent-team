ALTER TABLE "db_personal_role" ADD COLUMN "pending_password_encrypted" text;--> statement-breakpoint
ALTER TABLE "db_personal_role" ADD COLUMN "provisioned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "db_personal_role" ADD COLUMN "password_error" text;
--> statement-breakpoint
-- 已生效授权的既有身份已完成创建，不在迁移后首次读取时重放只读授权并断开会话。
UPDATE "db_personal_role" AS r SET "provisioned" = true
WHERE EXISTS (
  SELECT 1 FROM "db_access_grant" g
  JOIN "db_catalog" c ON c.id = g.catalog_id
  WHERE g.user_id = r.user_id AND c.instance_id = r.instance_id AND g.state = 'active'
);
