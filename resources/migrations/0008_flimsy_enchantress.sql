CREATE TABLE "sms_consent_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"phone_key" text NOT NULL,
	"phone" text NOT NULL,
	"old_status" text,
	"new_status" text NOT NULL,
	"source" text NOT NULL,
	"consent_text_shown" text,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
