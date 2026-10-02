CREATE TABLE `idempotency_keys` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`key_hash` text NOT NULL,
	`response_json` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `fk_idempotency_keys_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `user` ADD `free_credits` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `cal_token` text;--> statement-breakpoint
ALTER TABLE `events` ADD `confidence` real;--> statement-breakpoint
ALTER TABLE `events` ADD `source_quote` text;--> statement-breakpoint
ALTER TABLE `uploads` ADD `callback_url` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_user` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`email` text NOT NULL UNIQUE,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`stripe_customer_id` text,
	`phone_number` text,
	`use_case` text,
	`calendar_app` text,
	`free_credits` integer DEFAULT 1 NOT NULL,
	`cal_token` text UNIQUE,
	`is_onboarded` integer DEFAULT false NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`banned` integer DEFAULT false NOT NULL,
	`ban_reason` text,
	`ban_expires` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_user`(`id`, `name`, `email`, `email_verified`, `image`, `stripe_customer_id`, `phone_number`, `use_case`, `calendar_app`, `is_onboarded`, `role`, `banned`, `ban_reason`, `ban_expires`, `created_at`, `updated_at`) SELECT `id`, `name`, `email`, `email_verified`, `image`, `stripe_customer_id`, `phone_number`, `use_case`, `calendar_app`, `is_onboarded`, `role`, `banned`, `ban_reason`, `ban_expires`, `created_at`, `updated_at` FROM `user`;--> statement-breakpoint
DROP TABLE `user`;--> statement-breakpoint
ALTER TABLE `__new_user` RENAME TO `user`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_user_key_idx` ON `idempotency_keys` (`user_id`,`key_hash`);