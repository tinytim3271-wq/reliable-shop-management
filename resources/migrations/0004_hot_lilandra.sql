ALTER TABLE "store_orders" ADD COLUMN "order_secret_hash" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "read_at" timestamp with time zone;