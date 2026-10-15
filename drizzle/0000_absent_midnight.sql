CREATE TABLE `projects` (
	`slug` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repos` text NOT NULL,
	`folders` text NOT NULL,
	`github` text NOT NULL,
	`claude_project` text,
	`keywords` text NOT NULL,
	`colour` text,
	`pinned` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
