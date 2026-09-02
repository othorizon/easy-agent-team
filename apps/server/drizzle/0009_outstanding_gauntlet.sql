CREATE UNIQUE INDEX "deployment_dokploy_idx" ON "deployment" USING btree ("dokploy_deployment_id");--> statement-breakpoint
ALTER TABLE "deployment" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "deployment" DROP COLUMN "error";--> statement-breakpoint
ALTER TABLE "deployment" DROP COLUMN "updated_at";