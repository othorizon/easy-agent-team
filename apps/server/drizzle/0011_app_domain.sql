-- 决策 32：建应用时自动分配域名。
-- dokploy_setting 加域名后缀与 HTTPS 开关；app 加容器端口（域名流量转发到它）、分配到的域名、
-- 分配时的 HTTPS 与 Dokploy 侧的域名记录 id（改端口时回写用）。存量应用 domain 为 NULL，即「未分配」。
ALTER TABLE "app" ADD COLUMN "port" integer DEFAULT 3000 NOT NULL;--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "domain" text;--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "domain_https" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app" ADD COLUMN "dokploy_domain_id" text;--> statement-breakpoint
ALTER TABLE "dokploy_setting" ADD COLUMN "domain_suffix" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "dokploy_setting" ADD COLUMN "domain_https" boolean DEFAULT false NOT NULL;