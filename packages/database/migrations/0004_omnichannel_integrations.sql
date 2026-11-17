CREATE TABLE `affiliate_clicks` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`link_id` text NOT NULL,
	`referrer_host` text,
	`country` text,
	`clicked_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`link_id`) REFERENCES `affiliate_links`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `affiliate_clicks_link_idx` ON `affiliate_clicks` (`link_id`,`clicked_at`);--> statement-breakpoint
CREATE TABLE `affiliate_conversions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`link_id` text NOT NULL,
	`network_id` text NOT NULL,
	`external_ref` text NOT NULL,
	`sale_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`commission_cents` integer NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`source_ref` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`recorded_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`link_id`) REFERENCES `affiliate_links`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`network_id`) REFERENCES `affiliate_networks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `affiliate_conversions_ref_uq` ON `affiliate_conversions` (`tenant_id`,`network_id`,`external_ref`);--> statement-breakpoint
CREATE TABLE `affiliate_links` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`product_id` text NOT NULL,
	`network_id` text NOT NULL,
	`code` text NOT NULL,
	`destination_url` text NOT NULL,
	`campaign` text,
	`channel` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `affiliate_products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`network_id`) REFERENCES `affiliate_networks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `affiliate_links_code_unique` ON `affiliate_links` (`code`);--> statement-breakpoint
CREATE TABLE `affiliate_networks` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`website` text,
	`status` text DEFAULT 'NOT_CONFIGURED' NOT NULL,
	`terms_ref` text,
	`cookie_days` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `affiliate_networks_name_uq` ON `affiliate_networks` (`tenant_id`,`name`);--> statement-breakpoint
CREATE TABLE `affiliate_products` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`network_id` text NOT NULL,
	`title` text NOT NULL,
	`product_url` text NOT NULL,
	`external_ref` text,
	`commission_rate_bps` integer,
	`commission_source_ref` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`network_id`) REFERENCES `affiliate_networks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `channel_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`channel` text NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'NOT_CONFIGURED' NOT NULL,
	`status_detail` text DEFAULT '' NOT NULL,
	`display_name` text NOT NULL,
	`external_account_id` text,
	`external_account_name` text,
	`scopes` text NOT NULL,
	`access_token_enc` text,
	`refresh_token_enc` text,
	`token_expires_at` integer,
	`last_checked_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `channel_connections_tenant_idx` ON `channel_connections` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `channel_connections_account_idx` ON `channel_connections` (`channel`,`external_account_id`);--> statement-breakpoint
CREATE TABLE `channel_listings` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`discovered_product_id` text,
	`product_id` text,
	`content_id` text,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`external_id` text,
	`external_url` text,
	`draft` text NOT NULL,
	`gate` text,
	`idempotency_key` text NOT NULL,
	`last_error` text,
	`published_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `channel_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`discovered_product_id`) REFERENCES `discovered_products`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`content_id`) REFERENCES `generated_contents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_listings_idem_uq` ON `channel_listings` (`tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `channel_listings_conn_idx` ON `channel_listings` (`connection_id`,`status`);--> statement-breakpoint
CREATE TABLE `channel_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`channel` text NOT NULL,
	`direction` text NOT NULL,
	`kind` text NOT NULL,
	`external_id` text,
	`contact_ref` text NOT NULL,
	`body` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `channel_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_messages_ext_uq` ON `channel_messages` (`connection_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `channel_messages_contact_idx` ON `channel_messages` (`connection_id`,`contact_ref`,`created_at`);--> statement-breakpoint
CREATE TABLE `channel_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`external_order_id` text NOT NULL,
	`status` text NOT NULL,
	`raw_status` text NOT NULL,
	`total_cents` integer,
	`currency` text,
	`placed_at` integer,
	`synced_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `channel_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_orders_ext_uq` ON `channel_orders` (`connection_id`,`external_order_id`);--> statement-breakpoint
CREATE TABLE `integration_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`connection_id` text,
	`channel` text NOT NULL,
	`operation` text NOT NULL,
	`outcome` text NOT NULL,
	`error_code` text,
	`message` text,
	`http_status` integer,
	`duration_ms` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `channel_connections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `integration_logs_tenant_idx` ON `integration_logs` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`state_hash` text NOT NULL,
	`code_verifier_enc` text,
	`redirect_uri` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `channel_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_states_state_hash_unique` ON `oauth_states` (`state_hash`);--> statement-breakpoint
CREATE TABLE `rate_limit_windows` (
	`key` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`channel` text NOT NULL,
	`connection_id` text,
	`dedupe_key` text NOT NULL,
	`topic` text NOT NULL,
	`resource` text,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`received_at` integer NOT NULL,
	`processed_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `channel_connections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_events_dedupe_uq` ON `webhook_events` (`channel`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `webhook_events_tenant_idx` ON `webhook_events` (`tenant_id`,`received_at`);