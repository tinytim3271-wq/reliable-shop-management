CREATE TABLE "qbo_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"realm_id" text,
	"access_token" text,
	"refresh_token" text,
	"token_expires_at" timestamp with time zone,
	"company_name" text,
	"connected_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"account_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qbo_oauth_states" (
	"id" serial PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qbo_oauth_states_state_unique" UNIQUE("state")
);
--> statement-breakpoint
CREATE TABLE "qbo_sync_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" integer NOT NULL,
	"qbo_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempted_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "qbo_customer_id" text;--> statement-breakpoint
ALTER TABLE "shop_settings" ADD COLUMN "voice_sensitivity" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "attachment_path" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "attachment_name" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "attachment_mime_type" text;