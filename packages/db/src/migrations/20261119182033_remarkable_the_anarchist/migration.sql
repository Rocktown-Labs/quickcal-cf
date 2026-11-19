-- Deduplicate natural keys before adding unique indexes. Keep the oldest row
-- in each group so the migration is safe on existing data.
DELETE FROM `account`
WHERE `rowid` NOT IN (SELECT MIN(`rowid`) FROM `account` GROUP BY `provider_id`, `account_id`);--> statement-breakpoint
DELETE FROM `oauth_consent`
WHERE `user_id` IS NOT NULL
  AND `rowid` NOT IN (
    SELECT MIN(`rowid`) FROM `oauth_consent`
    WHERE `user_id` IS NOT NULL GROUP BY `client_id`, `user_id`
  );--> statement-breakpoint
DELETE FROM `subscription`
WHERE `stripe_subscription_id` IS NOT NULL
  AND `rowid` NOT IN (
    SELECT MIN(`rowid`) FROM `subscription`
    WHERE `stripe_subscription_id` IS NOT NULL GROUP BY `stripe_subscription_id`
  );--> statement-breakpoint
DELETE FROM `plan`
WHERE `rowid` NOT IN (SELECT MIN(`rowid`) FROM `plan` GROUP BY `price_id`);--> statement-breakpoint
DELETE FROM `plan`
WHERE `stripe_product_id` IS NOT NULL
  AND `rowid` NOT IN (
    SELECT MIN(`rowid`) FROM `plan`
    WHERE `stripe_product_id` IS NOT NULL GROUP BY `stripe_product_id`
  );--> statement-breakpoint
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
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	CONSTRAINT "user_freeCredits_non_negative" CHECK("free_credits" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_user`(`id`, `name`, `email`, `email_verified`, `image`, `stripe_customer_id`, `phone_number`, `use_case`, `calendar_app`, `free_credits`, `cal_token`, `is_onboarded`, `role`, `banned`, `ban_reason`, `ban_expires`, `created_at`, `updated_at`) SELECT `id`, `name`, `email`, `email_verified`, `image`, `stripe_customer_id`, `phone_number`, `use_case`, `calendar_app`, `free_credits`, `cal_token`, `is_onboarded`, `role`, `banned`, `ban_reason`, `ban_expires`, `created_at`, `updated_at` FROM `user`;--> statement-breakpoint
DROP TABLE `user`;--> statement-breakpoint
ALTER TABLE `__new_user` RENAME TO `user`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_uploads` (
	`id` text PRIMARY KEY,
	`file_name` text NOT NULL,
	`file_type` text NOT NULL,
	`storage_key` text NOT NULL,
	`ics_key` text,
	`share_token` text UNIQUE,
	`workflow_run_id` text UNIQUE,
	`callback_url` text,
	`failure_reason` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	CONSTRAINT `fk_uploads_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_uploads`(`id`, `file_name`, `file_type`, `storage_key`, `ics_key`, `share_token`, `workflow_run_id`, `callback_url`, `failure_reason`, `status`, `user_id`, `created_at`, `updated_at`) SELECT `id`, `file_name`, `file_type`, `storage_key`, `ics_key`, `share_token`, `workflow_run_id`, `callback_url`, `failure_reason`, `status`, `user_id`, `created_at`, `updated_at` FROM `uploads`;--> statement-breakpoint
DROP TABLE `uploads`;--> statement-breakpoint
ALTER TABLE `__new_uploads` RENAME TO `uploads`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_plan` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL UNIQUE,
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
INSERT INTO `__new_plan`(`id`, `name`, `display_name`, `description`, `stripe_product_id`, `price_id`, `annual_discount_price_id`, `currency`, `limits`, `active`, `created_at`, `updated_at`) SELECT `id`, `name`, `display_name`, `description`, `stripe_product_id`, `price_id`, `annual_discount_price_id`, `currency`, `limits`, `active`, `created_at`, `updated_at` FROM `plan`;--> statement-breakpoint
DROP TABLE `plan`;--> statement-breakpoint
ALTER TABLE `__new_plan` RENAME TO `plan`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_oauth_access_token` (
	`id` text PRIMARY KEY,
	`token` text NOT NULL UNIQUE,
	`client_id` text NOT NULL,
	`session_id` text,
	`user_id` text,
	`reference_id` text,
	`authorization_code_id` text,
	`resources` text,
	`requested_user_info_claims` text,
	`refresh_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`revoked` integer,
	`confirmation` text,
	`scopes` text NOT NULL,
	CONSTRAINT `fk_oauth_access_token_client_id_oauth_client_client_id_fk` FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_oauth_access_token_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_oauth_access_token_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_oauth_access_token_refresh_id_oauth_refresh_token_id_fk` FOREIGN KEY (`refresh_id`) REFERENCES `oauth_refresh_token`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO `__new_oauth_access_token`(`id`, `token`, `client_id`, `session_id`, `user_id`, `reference_id`, `authorization_code_id`, `resources`, `requested_user_info_claims`, `refresh_id`, `expires_at`, `created_at`, `revoked`, `confirmation`, `scopes`) SELECT `id`, `token`, `client_id`, `session_id`, `user_id`, `reference_id`, `authorization_code_id`, `resources`, `requested_user_info_claims`, `refresh_id`, `expires_at`, `created_at`, `revoked`, `confirmation`, `scopes` FROM `oauth_access_token`;--> statement-breakpoint
DROP TABLE `oauth_access_token`;--> statement-breakpoint
ALTER TABLE `__new_oauth_access_token` RENAME TO `oauth_access_token`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_oauth_client` (
	`id` text PRIMARY KEY,
	`client_id` text NOT NULL UNIQUE,
	`client_secret` text,
	`client_discovery_id` text,
	`disabled` integer DEFAULT false NOT NULL,
	`skip_consent` integer DEFAULT false NOT NULL,
	`enable_end_session` integer DEFAULT false NOT NULL,
	`subject_type` text,
	`scopes` text,
	`client_credentials_scopes` text DEFAULT '[]',
	`user_id` text,
	`created_at` integer,
	`updated_at` integer,
	`name` text,
	`uri` text,
	`icon` text,
	`contacts` text,
	`tos` text,
	`policy` text,
	`software_id` text,
	`software_version` text,
	`software_statement` text,
	`redirect_uris` text NOT NULL,
	`post_logout_redirect_uris` text,
	`backchannel_logout_uri` text,
	`backchannel_logout_session_required` integer,
	`token_endpoint_auth_method` text,
	`application_type` text,
	`jwks` text,
	`jwks_uri` text,
	`grant_types` text,
	`response_types` text,
	`require_pkce` integer,
	`dpop_bound_access_tokens` integer DEFAULT false NOT NULL,
	`reference_id` text,
	`metadata` text,
	CONSTRAINT `fk_oauth_client_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_oauth_client`(`id`, `client_id`, `client_secret`, `client_discovery_id`, `disabled`, `skip_consent`, `enable_end_session`, `subject_type`, `scopes`, `client_credentials_scopes`, `user_id`, `created_at`, `updated_at`, `name`, `uri`, `icon`, `contacts`, `tos`, `policy`, `software_id`, `software_version`, `software_statement`, `redirect_uris`, `post_logout_redirect_uris`, `backchannel_logout_uri`, `backchannel_logout_session_required`, `token_endpoint_auth_method`, `application_type`, `jwks`, `jwks_uri`, `grant_types`, `response_types`, `require_pkce`, `dpop_bound_access_tokens`, `reference_id`, `metadata`) SELECT `id`, `client_id`, `client_secret`, `client_discovery_id`, `disabled`, `skip_consent`, `enable_end_session`, `subject_type`, `scopes`, `client_credentials_scopes`, `user_id`, `created_at`, `updated_at`, `name`, `uri`, `icon`, `contacts`, `tos`, `policy`, `software_id`, `software_version`, `software_statement`, `redirect_uris`, `post_logout_redirect_uris`, `backchannel_logout_uri`, `backchannel_logout_session_required`, `token_endpoint_auth_method`, `application_type`, `jwks`, `jwks_uri`, `grant_types`, `response_types`, `require_pkce`, `dpop_bound_access_tokens`, `reference_id`, `metadata` FROM `oauth_client`;--> statement-breakpoint
DROP TABLE `oauth_client`;--> statement-breakpoint
ALTER TABLE `__new_oauth_client` RENAME TO `oauth_client`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_oauth_resource` (
	`id` text PRIMARY KEY,
	`identifier` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`access_token_ttl` integer,
	`refresh_token_ttl` integer,
	`signing_algorithm` text,
	`signing_key_id` text,
	`allowed_scopes` text,
	`custom_claims` text,
	`dpop_bound_access_tokens_required` integer DEFAULT false NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`created_at` integer,
	`updated_at` integer,
	`policy_version` integer DEFAULT 1 NOT NULL,
	`metadata` text
);
--> statement-breakpoint
INSERT INTO `__new_oauth_resource`(`id`, `identifier`, `name`, `access_token_ttl`, `refresh_token_ttl`, `signing_algorithm`, `signing_key_id`, `allowed_scopes`, `custom_claims`, `dpop_bound_access_tokens_required`, `disabled`, `created_at`, `updated_at`, `policy_version`, `metadata`) SELECT `id`, `identifier`, `name`, `access_token_ttl`, `refresh_token_ttl`, `signing_algorithm`, `signing_key_id`, `allowed_scopes`, `custom_claims`, `dpop_bound_access_tokens_required`, `disabled`, `created_at`, `updated_at`, `policy_version`, `metadata` FROM `oauth_resource`;--> statement-breakpoint
DROP TABLE `oauth_resource`;--> statement-breakpoint
ALTER TABLE `__new_oauth_resource` RENAME TO `oauth_resource`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP INDEX IF EXISTS `plan_name_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `oauthClientResource_clientId_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `uploads_shareToken_idx`;--> statement-breakpoint
CREATE INDEX `user_stripeCustomerId_idx` ON `user` (`stripe_customer_id`);--> statement-breakpoint
CREATE INDEX `uploads_userId_idx` ON `uploads` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `plan_priceId_idx` ON `plan` (`price_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `plan_stripeProductId_idx` ON `plan` (`stripe_product_id`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_clientId_idx` ON `oauth_access_token` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_sessionId_idx` ON `oauth_access_token` (`session_id`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_userId_idx` ON `oauth_access_token` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_authorizationCodeId_idx` ON `oauth_access_token` (`authorization_code_id`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_refreshId_idx` ON `oauth_access_token` (`refresh_id`);--> statement-breakpoint
CREATE INDEX `oauthClient_userId_idx` ON `oauth_client` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_providerId_accountId_idx` ON `account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauthConsent_clientId_userId_idx` ON `oauth_consent` (`client_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idempotency_expiresAt_idx` ON `idempotency_keys` (`expires_at`);--> statement-breakpoint
CREATE INDEX `subscription_stripeCustomerId_idx` ON `subscription` (`stripe_customer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_stripeSubscriptionId_idx` ON `subscription` (`stripe_subscription_id`);