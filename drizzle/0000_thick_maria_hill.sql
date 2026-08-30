CREATE TABLE `assets` (
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`group_id` text NOT NULL,
	`slot` text NOT NULL,
	`path` text NOT NULL,
	`filename` text NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`modified_at` text NOT NULL,
	`width` integer,
	`height` integer,
	`duration` integer,
	`available` integer DEFAULT true NOT NULL,
	`thumbnail` text,
	PRIMARY KEY(`owner`, `id`)
);
--> statement-breakpoint
CREATE INDEX `assets_owner_group` ON `assets` (`owner`,`group_id`);
--> statement-breakpoint
CREATE TABLE `platform_accounts` (
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	PRIMARY KEY(`owner`, `id`)
);
--> statement-breakpoint
CREATE TABLE `publish_marks` (
	`owner` text NOT NULL,
	`group_id` text NOT NULL,
	`version` text NOT NULL,
	`platform_id` text NOT NULL,
	`published` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner`, `group_id`, `version`, `platform_id`)
);
--> statement-breakpoint
CREATE TABLE `scan_sources` (
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`path` text NOT NULL,
	`last_scanned_at` text,
	PRIMARY KEY(`owner`, `id`)
);
--> statement-breakpoint
CREATE TABLE `sync_metadata` (
	`owner` text PRIMARY KEY NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `video_groups` (
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`category` text NOT NULL,
	`code` text NOT NULL,
	`title` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `video_groups_owner_category_code` ON `video_groups` (`owner`,`category`,`code`);
