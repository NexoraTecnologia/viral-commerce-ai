CREATE TABLE `supplier_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`supplier_id` text NOT NULL,
	`category` text NOT NULL,
	`description` text NOT NULL,
	`reference` text NOT NULL,
	`review_status` text DEFAULT 'PENDING' NOT NULL,
	`review_notes` text,
	`reviewed_by_user_id` text,
	`reviewed_at` integer,
	`recorded_by_user_id` text,
	`expires_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `supplier_evidence_supplier_idx` ON `supplier_evidence` (`supplier_id`,`category`);--> statement-breakpoint
CREATE TABLE `supplier_status_history` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`supplier_id` text NOT NULL,
	`from_status` text NOT NULL,
	`to_status` text NOT NULL,
	`reason` text NOT NULL,
	`actor_user_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `supplier_status_history_supplier_idx` ON `supplier_status_history` (`supplier_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `suppliers` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`legal_name` text NOT NULL,
	`trade_name` text,
	`tax_id` text,
	`website` text,
	`country_code` text NOT NULL,
	`province` text,
	`city` text,
	`address` text,
	`contacts` text DEFAULT '[]' NOT NULL,
	`payment_methods` text DEFAULT '[]' NOT NULL,
	`direct_dispatch` integer NOT NULL,
	`dispatch_lead_time_days_min` integer,
	`dispatch_lead_time_days_max` integer,
	`delivery_time_days_min` integer,
	`delivery_time_days_max` integer,
	`accepts_returns` integer NOT NULL,
	`return_window_days` integer,
	`return_policy_notes` text,
	`tracking_available` integer NOT NULL,
	`requires_prepayment` integer NOT NULL,
	`payment_due_days` integer,
	`status` text DEFAULT 'UNVERIFIED' NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `suppliers_tenant_status_idx` ON `suppliers` (`tenant_id`,`status`);--> statement-breakpoint
CREATE INDEX `suppliers_tenant_tax_id_idx` ON `suppliers` (`tenant_id`,`tax_id`);--> statement-breakpoint
CREATE TABLE `product_costs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`product_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`fixed_cents` integer,
	`rate_bps` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `product_costs_product_idx` ON `product_costs` (`product_id`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`category` text,
	`sale_price_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `products_tenant_status_idx` ON `products` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `supplier_inventory` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`supplier_product_id` text NOT NULL,
	`stock_status` text NOT NULL,
	`quantity` integer,
	`checked_at` integer NOT NULL,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`supplier_product_id`) REFERENCES `supplier_products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `supplier_inventory_product_checked_idx` ON `supplier_inventory` (`supplier_product_id`,`checked_at`);--> statement-breakpoint
CREATE TABLE `supplier_products` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`supplier_id` text NOT NULL,
	`product_id` text,
	`supplier_sku` text NOT NULL,
	`title` text NOT NULL,
	`wholesale_price_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`price_updated_at` integer NOT NULL,
	`price_source` text NOT NULL,
	`min_order_qty` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `supplier_products_supplier_sku_uq` ON `supplier_products` (`supplier_id`,`supplier_sku`);--> statement-breakpoint
CREATE INDEX `supplier_products_tenant_product_idx` ON `supplier_products` (`tenant_id`,`product_id`);--> statement-breakpoint
CREATE TABLE `profit_calculations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`product_id` text NOT NULL,
	`supplier_product_id` text NOT NULL,
	`currency` text NOT NULL,
	`status` text NOT NULL,
	`issues` text NOT NULL,
	`sale_price_cents` integer NOT NULL,
	`total_costs_cents` integer,
	`net_profit_cents` integer,
	`margin_bps` integer,
	`min_margin_bps` integer NOT NULL,
	`breakdown` text,
	`input_snapshot` text NOT NULL,
	`calculated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`supplier_product_id`) REFERENCES `supplier_products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `profit_calculations_tenant_calc_idx` ON `profit_calculations` (`tenant_id`,`calculated_at`);--> statement-breakpoint
CREATE INDEX `profit_calculations_product_idx` ON `profit_calculations` (`product_id`,`calculated_at`);