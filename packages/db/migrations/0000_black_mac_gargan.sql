CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"scan_id" text NOT NULL,
	"charter_id" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"t0" timestamp with time zone,
	"video_key" text,
	"rrweb_key" text,
	"trace_key" text,
	"timeline_key" text,
	"tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "api_keys_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "bandit_arms" (
	"project_id" text NOT NULL,
	"area" text NOT NULL,
	"charter_type" text NOT NULL,
	"alpha" double precision DEFAULT 1 NOT NULL,
	"beta" double precision DEFAULT 1 NOT NULL,
	"cost_avg" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "bandit_arms_project_id_area_charter_type_pk" PRIMARY KEY("project_id","area","charter_type")
);
--> statement-breakpoint
CREATE TABLE "charters" (
	"id" text PRIMARY KEY NOT NULL,
	"scan_id" text NOT NULL,
	"type" text NOT NULL,
	"area" text,
	"goal" text NOT NULL,
	"persona_id" text,
	"start_path" text,
	"viewport" text,
	"score" real
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"base_url" text NOT NULL,
	"allowed_actions" text DEFAULT 'read_only' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finding_occurrences" (
	"finding_id" text NOT NULL,
	"agent_run_id" text NOT NULL,
	"step_id" text NOT NULL,
	CONSTRAINT "finding_occurrences_finding_id_agent_run_id_step_id_pk" PRIMARY KEY("finding_id","agent_run_id","step_id")
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"scan_id" text,
	"signature" text NOT NULL,
	"priority" text NOT NULL,
	"title" text NOT NULL,
	"expected" text NOT NULL,
	"actual" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"confirm_json" jsonb,
	"fix_status" text,
	"prompt_variant" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"scan_id" text,
	"agent_run_id" text,
	"role" text NOT NULL,
	"model" text NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locator_memory" (
	"project_id" text NOT NULL,
	"state_hash" text NOT NULL,
	"intent" text NOT NULL,
	"locator_json" jsonb NOT NULL,
	"ok_count" integer DEFAULT 0 NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "noise" (
	"project_id" text NOT NULL,
	"signature" text NOT NULL,
	"dismiss_count" integer DEFAULT 0 NOT NULL,
	"suppressed" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "noise_project_id_signature_pk" PRIMARY KEY("project_id","signature")
);
--> statement-breakpoint
CREATE TABLE "personas" (
	"id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"credentials_enc" text,
	"storage_state_key" text,
	"auth_recipe_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "playbooks" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"version" integer NOT NULL,
	"body_md" text NOT NULL,
	"diff" text,
	"stats_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reverted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_maps" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"version" integer NOT NULL,
	"map_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_variants" (
	"id" text PRIMARY KEY NOT NULL,
	"template" text NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"fixes" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scans" (
	"id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"team_size" integer DEFAULT 1 NOT NULL,
	"focus" text,
	"viewports" jsonb,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scenario_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"scenario_id" text NOT NULL,
	"agent_run_id" text,
	"status" text DEFAULT 'queued' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scenarios" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"yaml" text NOT NULL,
	"triggers" jsonb,
	"source_finding_id" text,
	"locator_seq_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "steps" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_run_id" text NOT NULL,
	"n" integer NOT NULL,
	"action_json" jsonb NOT NULL,
	"locator_json" jsonb,
	"intent" text,
	"expectation" text,
	"t_ms" integer NOT NULL,
	"state_hash" text,
	"screenshot_key" text,
	"signals_json" jsonb,
	"reasoning_summary" text
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_charter_id_charters_id_fk" FOREIGN KEY ("charter_id") REFERENCES "public"."charters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bandit_arms" ADD CONSTRAINT "bandit_arms_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charters" ADD CONSTRAINT "charters_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charters" ADD CONSTRAINT "charters_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_occurrences" ADD CONSTRAINT "finding_occurrences_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_occurrences" ADD CONSTRAINT "finding_occurrences_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_occurrences" ADD CONSTRAINT "finding_occurrences_step_id_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."steps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locator_memory" ADD CONSTRAINT "locator_memory_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "noise" ADD CONSTRAINT "noise_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas" ADD CONSTRAINT "personas_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_maps" ADD CONSTRAINT "product_maps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenario_runs" ADD CONSTRAINT "scenario_runs_scenario_id_scenarios_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."scenarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenario_runs" ADD CONSTRAINT "scenario_runs_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_source_finding_id_findings_id_fk" FOREIGN KEY ("source_finding_id") REFERENCES "public"."findings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steps" ADD CONSTRAINT "steps_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "findings_project_signature_uq" ON "findings" USING btree ("project_id","signature");--> statement-breakpoint
CREATE INDEX "llm_usage_scan_idx" ON "llm_usage" USING btree ("scan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "locator_memory_project_state_intent_uq" ON "locator_memory" USING btree ("project_id","state_hash","intent");--> statement-breakpoint
CREATE UNIQUE INDEX "playbooks_project_version_uq" ON "playbooks" USING btree ("project_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "product_maps_project_version_uq" ON "product_maps" USING btree ("project_id","version");