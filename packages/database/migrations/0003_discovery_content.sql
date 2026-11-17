CREATE TABLE `competitors` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`channel` text NOT NULL,
	`url` text,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `competitors_tenant_idx` ON `competitors` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `demand_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`discovered_product_id` text NOT NULL,
	`metric` text NOT NULL,
	`value` real NOT NULL,
	`unit` text NOT NULL,
	`source_id` text NOT NULL,
	`source_ref` text NOT NULL,
	`observed_at` integer NOT NULL,
	`recorded_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`discovered_product_id`) REFERENCES `discovered_products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `research_sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `demand_observations_product_idx` ON `demand_observations` (`discovered_product_id`,`observed_at`);--> statement-breakpoint
CREATE TABLE `discovered_products` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'RESEARCHING' NOT NULL,
	`discard_reason` text,
	`category_id` text,
	`category_source` text,
	`source_id` text NOT NULL,
	`source_ref` text NOT NULL,
	`observed_at` integer NOT NULL,
	`product_id` text,
	`supplier_product_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `product_categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_id`) REFERENCES `research_sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`supplier_product_id`) REFERENCES `supplier_products`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `discovered_products_tenant_status_idx` ON `discovered_products` (`tenant_id`,`status`);--> statement-breakpoint
CREATE INDEX `discovered_products_supplier_product_idx` ON `discovered_products` (`supplier_product_id`);--> statement-breakpoint
CREATE TABLE `discovery_analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`discovered_product_id` text NOT NULL,
	`score` integer NOT NULL,
	`confidence` real NOT NULL,
	`opportunity` integer NOT NULL,
	`saturated` integer NOT NULL,
	`risk_passed` integer NOT NULL,
	`score_detail` text NOT NULL,
	`signals` text NOT NULL,
	`risk` text NOT NULL,
	`analyzed_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`discovered_product_id`) REFERENCES `discovered_products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `discovery_analyses_product_idx` ON `discovery_analyses` (`discovered_product_id`,`analyzed_at`);--> statement-breakpoint
CREATE TABLE `generated_contents` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`discovered_product_id` text NOT NULL,
	`version` integer NOT NULL,
	`template_version` text NOT NULL,
	`content` text NOT NULL,
	`compliance` text NOT NULL,
	`facts_snapshot` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`discovered_product_id`) REFERENCES `discovered_products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `generated_contents_product_version_uq` ON `generated_contents` (`discovered_product_id`,`version`);--> statement-breakpoint
CREATE TABLE `price_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`discovered_product_id` text NOT NULL,
	`competitor_id` text,
	`price_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`source_id` text NOT NULL,
	`source_ref` text NOT NULL,
	`observed_at` integer NOT NULL,
	`recorded_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`discovered_product_id`) REFERENCES `discovered_products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`competitor_id`) REFERENCES `competitors`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_id`) REFERENCES `research_sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `price_observations_product_idx` ON `price_observations` (`discovered_product_id`,`observed_at`);--> statement-breakpoint
CREATE TABLE `product_attributes` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`discovered_product_id` text NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`verification` text NOT NULL,
	`source_id` text NOT NULL,
	`source_ref` text NOT NULL,
	`observed_at` integer NOT NULL,
	`recorded_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`discovered_product_id`) REFERENCES `discovered_products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `research_sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `product_attributes_product_idx` ON `product_attributes` (`discovered_product_id`);--> statement-breakpoint
CREATE TABLE `product_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`keywords` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_categories_tenant_name_uq` ON `product_categories` (`tenant_id`,`name`);--> statement-breakpoint
CREATE TABLE `product_images` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`discovered_product_id` text NOT NULL,
	`url` text NOT NULL,
	`authorization` text NOT NULL,
	`authorization_ref` text,
	`recorded_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`discovered_product_id`) REFERENCES `discovered_products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `product_images_product_idx` ON `product_images` (`discovered_product_id`);--> statement-breakpoint
CREATE TABLE `research_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`reference` text,
	`usage_authorization` text,
	`enabled` integer DEFAULT true NOT NULL,
	`last_sync_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `research_sources_tenant_idx` ON `research_sources` (`tenant_id`);