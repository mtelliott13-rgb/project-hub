CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_slug` text,
	`cwd` text NOT NULL,
	`transcript_path` text,
	`title` text,
	`model` text,
	`git_branch` text,
	`kind` text,
	`state` text NOT NULL,
	`end_reason` text,
	`started_at` integer,
	`last_active_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`project_slug`) REFERENCES `projects`(`slug`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_project_idx` ON `sessions` (`project_slug`,`last_active_at`);