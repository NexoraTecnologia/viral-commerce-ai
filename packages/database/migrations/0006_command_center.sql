CREATE TABLE `rule_change_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`rule_key` text NOT NULL,
	`current_value` text NOT NULL,
	`proposed_value` text NOT NULL,
	`reason` text NOT NULL,
	`financial` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `rule_change_requests_tenant_idx` ON `rule_change_requests` (`tenant_id`,`created_at`);