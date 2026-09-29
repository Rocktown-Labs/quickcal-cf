CREATE TABLE `plan` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`display_name` text NOT NULL,
	`description` text,
	`stripe_product_id` text,
	`price_id` text NOT NULL,
	`annual_discount_price_id` text,
	`currency` text DEFAULT 'usd' NOT NULL,
	`limits` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `plan_name_idx` ON `plan` (`name`);