ALTER TABLE "env_variable" ALTER COLUMN "value_encrypted" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "env_variable" ADD COLUMN "value_plain" text;--> statement-breakpoint
ALTER TABLE "env_variable" ADD COLUMN "secret" boolean DEFAULT true NOT NULL;