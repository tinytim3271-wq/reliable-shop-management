CREATE TABLE "auth_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "work_orders" ADD COLUMN "billed_banner_dismissed_hash" text;--> statement-breakpoint
ALTER TABLE "work_order_line_items" ADD COLUMN "catalog_part_id" integer;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD COLUMN "catalog_part_id" integer;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_line_items" ADD CONSTRAINT "work_order_line_items_catalog_part_id_parts_id_fk" FOREIGN KEY ("catalog_part_id") REFERENCES "public"."parts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_catalog_part_id_parts_id_fk" FOREIGN KEY ("catalog_part_id") REFERENCES "public"."parts"("id") ON DELETE set null ON UPDATE no action;