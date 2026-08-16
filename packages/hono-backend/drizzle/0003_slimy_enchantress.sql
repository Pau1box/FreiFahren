CREATE TYPE "public"."line_mode" AS ENUM('subway', 'light_rail', 'tram', 'train', 'unknown');--> statement-breakpoint
ALTER TABLE "lines" ADD COLUMN "color" varchar(7) DEFAULT '#000000' NOT NULL;--> statement-breakpoint
ALTER TABLE "lines" ADD COLUMN "mode" "line_mode" DEFAULT 'unknown' NOT NULL;