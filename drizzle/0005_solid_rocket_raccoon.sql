CREATE TABLE `link_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_slug` text NOT NULL,
	`host` text NOT NULL,
	`path_prefix` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_slug`) REFERENCES `projects`(`slug`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `link_rules_host_path_idx` ON `link_rules` (`host`,`path_prefix`);--> statement-breakpoint
CREATE TABLE `links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`key` text NOT NULL,
	`title` text,
	`project_slug` text,
	`filed_by` text,
	`rule_id` integer,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_slug`) REFERENCES `projects`(`slug`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rule_id`) REFERENCES `link_rules`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `links_key_unique` ON `links` (`key`);--> statement-breakpoint
CREATE INDEX `links_project_idx` ON `links` (`project_slug`,`created_at`);