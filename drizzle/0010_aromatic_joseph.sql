CREATE TABLE `note_dismissals` (
	`project_slug` text NOT NULL,
	`line_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_slug`) REFERENCES `projects`(`slug`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `note_dismissals_idx` ON `note_dismissals` (`project_slug`,`line_hash`);