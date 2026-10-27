ALTER TABLE "agent_runs" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "oracle" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "url" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "unjudged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "verdict_json" jsonb;--> statement-breakpoint
ALTER TABLE "steps" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "steps" ADD COLUMN "error" text;