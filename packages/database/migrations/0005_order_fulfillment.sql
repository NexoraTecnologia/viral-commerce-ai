CREATE TABLE `faq_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`question` text NOT NULL,
	`answer` text NOT NULL,
	`keywords` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `funds_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`available_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`as_of` integer NOT NULL,
	`source` text NOT NULL,
	`source_ref` text NOT NULL,
	`recorded_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `funds_snapshots_tenant_idx` ON `funds_snapshots` (`tenant_id`,`currency`,`as_of`);--> statement-breakpoint
CREATE TABLE `order_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_id` text NOT NULL,
	`type` text NOT NULL,
	`from_state` text,
	`to_state` text,
	`actor` text NOT NULL,
	`detail` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `order_events_order_idx` ON `order_events` (`order_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_id` text NOT NULL,
	`product_id` text NOT NULL,
	`title` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price_cents` integer NOT NULL,
	`supplier_product_id` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`supplier_product_id`) REFERENCES `supplier_products`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `order_ledger_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_id` text NOT NULL,
	`type` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`source_ref` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`recorded_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `order_ledger_order_idx` ON `order_ledger_entries` (`order_id`);--> statement-breakpoint
CREATE TABLE `order_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_id` text NOT NULL,
	`kind` text NOT NULL,
	`provider` text NOT NULL,
	`external_payment_id` text NOT NULL,
	`status` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`evidence_source` text NOT NULL,
	`evidence_ref` text NOT NULL,
	`observed_at` integer NOT NULL,
	`recorded_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_payments_event_uq` ON `order_payments` (`tenant_id`,`provider`,`external_payment_id`,`kind`,`status`);--> statement-breakpoint
CREATE INDEX `order_payments_order_idx` ON `order_payments` (`order_id`);--> statement-breakpoint
CREATE TABLE `order_returns` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_id` text NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`decision_note` text,
	`received_evidence_ref` text,
	`requested_at` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`number` integer NOT NULL,
	`source` text NOT NULL,
	`channel_order_id` text,
	`external_order_id` text,
	`state` text DEFAULT 'NEW' NOT NULL,
	`state_reason` text,
	`buyer_ref` text NOT NULL,
	`currency` text NOT NULL,
	`total_cents` integer NOT NULL,
	`expected_settlement_at` integer,
	`excluded_supplier_ids` text NOT NULL,
	`reserved_funds_cents` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_order_id`) REFERENCES `channel_orders`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_tenant_number_uq` ON `orders` (`tenant_id`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_channel_order_uq` ON `orders` (`tenant_id`,`channel_order_id`);--> statement-breakpoint
CREATE INDEX `orders_tenant_state_idx` ON `orders` (`tenant_id`,`state`);--> statement-breakpoint
CREATE TABLE `shipments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_id` text NOT NULL,
	`supplier_order_id` text,
	`carrier` text NOT NULL,
	`tracking_number` text NOT NULL,
	`tracking_url` text,
	`status` text NOT NULL,
	`confirmation_source` text NOT NULL,
	`confirmation_ref` text NOT NULL,
	`shipped_at` integer NOT NULL,
	`estimated_delivery_at` integer,
	`delivered_at` integer,
	`delivery_evidence_ref` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`supplier_order_id`) REFERENCES `supplier_orders`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `shipments_order_idx` ON `shipments` (`order_id`);--> statement-breakpoint
CREATE INDEX `shipments_status_eta_idx` ON `shipments` (`status`,`estimated_delivery_at`);--> statement-breakpoint
CREATE TABLE `supplier_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_id` text NOT NULL,
	`supplier_id` text NOT NULL,
	`status` text NOT NULL,
	`cost_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`request_ref` text,
	`requested_at` integer,
	`response_due_at` integer,
	`confirmation_ref` text,
	`confirmed_at` integer,
	`rejection_reason` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `supplier_orders_order_idx` ON `supplier_orders` (`order_id`);--> statement-breakpoint
CREATE INDEX `supplier_orders_due_idx` ON `supplier_orders` (`status`,`response_due_at`);--> statement-breakpoint
CREATE TABLE `support_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`direction` text NOT NULL,
	`body` text NOT NULL,
	`template_key` text,
	`faq_id` text,
	`status` text NOT NULL,
	`detail` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ticket_id`) REFERENCES `support_tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `support_messages_ticket_idx` ON `support_messages` (`ticket_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `support_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_id` text,
	`channel` text NOT NULL,
	`contact_ref` text NOT NULL,
	`subject` text NOT NULL,
	`status` text NOT NULL,
	`escalation_reason` text,
	`escalated_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `support_tickets_tenant_status_idx` ON `support_tickets` (`tenant_id`,`status`);