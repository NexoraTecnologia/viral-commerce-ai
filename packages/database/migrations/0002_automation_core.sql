CREATE TABLE `circuit_breakers` (
	`tenant_id` text NOT NULL,
	`key` text NOT NULL,
	`state` text NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`open_until` integer,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`tenant_id`, `key`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `job_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`worker_id` text NOT NULL,
	`status` text NOT NULL,
	`error_kind` text,
	`error` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`duration_ms` integer,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_attempts_job_idx` ON `job_attempts` (`job_id`,`attempt`);--> statement-breakpoint
CREATE TABLE `job_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`job_type` text NOT NULL,
	`payload` text NOT NULL,
	`frequency` text NOT NULL,
	`time_zone` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`priority` integer NOT NULL,
	`max_attempts` integer NOT NULL,
	`timeout_seconds` integer NOT NULL,
	`next_run_at` integer,
	`last_run_at` integer,
	`last_job_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_schedules_due_idx` ON `job_schedules` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`priority` integer NOT NULL,
	`payload` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`schedule_id` text,
	`run_at` integer NOT NULL,
	`expires_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer NOT NULL,
	`timeout_seconds` integer NOT NULL,
	`locked_by` text,
	`locked_until` integer,
	`dispatched_at` integer,
	`last_error` text,
	`last_error_kind` text,
	`result` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`schedule_id`) REFERENCES `job_schedules`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_tenant_idempotency_uq` ON `jobs` (`tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `jobs_dispatch_idx` ON `jobs` (`status`,`priority`,`run_at`);--> statement-breakpoint
CREATE INDEX `jobs_lock_idx` ON `jobs` (`status`,`locked_until`);--> statement-breakpoint
CREATE INDEX `jobs_tenant_created_idx` ON `jobs` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `locks` (
	`name` text PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`expires_at` integer NOT NULL
);
