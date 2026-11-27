CREATE TABLE `connectors` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`account` text,
	`last_sync_at` integer,
	`last_error` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
