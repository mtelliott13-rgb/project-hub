CREATE TABLE `calendar_events` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`all_day` integer NOT NULL,
	`start` text NOT NULL,
	`end` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`html_link` text,
	`project_slug` text,
	`recurring` integer DEFAULT false NOT NULL,
	`created_by_hub` integer DEFAULT false NOT NULL,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `calendar_events_start_idx` ON `calendar_events` (`starts_at`);