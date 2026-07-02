ALTER TABLE "store_issuance_alerts" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "store_issuance_alerts" ADD COLUMN "resolved_note" text;
