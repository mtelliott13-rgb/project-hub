CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`claude_project_id` text,
	`project_slug` text,
	`filed_by` text,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_active_at` integer NOT NULL,
	FOREIGN KEY (`project_slug`) REFERENCES `projects`(`slug`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chats_project_idx` ON `chats` (`project_slug`,`last_active_at`);--> statement-breakpoint
CREATE TABLE `claude_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`project_slug` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_slug`) REFERENCES `projects`(`slug`) ON UPDATE no action ON DELETE set null
);
