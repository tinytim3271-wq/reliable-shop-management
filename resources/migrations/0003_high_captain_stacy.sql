ALTER TABLE "shop_settings" ADD COLUMN "owner_alert_channel" text DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "direction" text DEFAULT 'outbound' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "provider_message_id" text;--> statement-breakpoint
CREATE INDEX "messages_direction_idx" ON "messages" USING btree ("direction");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_message_id_key" ON "messages" USING btree ("provider_message_id");