CREATE TABLE `job_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`job_key` text NOT NULL,
	`job_kind` text NOT NULL,
	`node_id` text NOT NULL,
	`runtime` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`exit_code` integer,
	`error` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`os` text,
	`runtimes` text DEFAULT '[]' NOT NULL,
	`labels` text DEFAULT '[]' NOT NULL,
	`capacity` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'offline' NOT NULL,
	`last_seen` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
