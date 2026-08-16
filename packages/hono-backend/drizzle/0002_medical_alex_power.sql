-- Introduces the `network` as a first class concept so that one deployment can serve more than
-- one transit system.
--
-- This migration is hand written rather than left as drizzle-kit generated it. The generated
-- version cannot run against a database that already holds data, for four reasons:
--   1. it adds `network_id` as `NOT NULL` without a default, which fails on a non-empty table,
--   2. it installs the new composite primary keys before the columns they reference exist,
--   3. it leaves the `DROP CONSTRAINT` for the old single column `lines` primary key commented out,
--      so `ADD CONSTRAINT ... PRIMARY KEY` fails with "multiple primary keys are not allowed",
--   4. it has no backfill, so existing rows have no network to belong to.
--
-- The order below is therefore deliberate: create the network, backfill every table, and only then
-- tighten the constraints.

CREATE TYPE "public"."network_status" AS ENUM('active', 'beta');--> statement-breakpoint
CREATE TABLE "networks" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"country_code" varchar(2) NOT NULL,
	"timezone" varchar(64) NOT NULL,
	"center_lat" double precision NOT NULL,
	"center_lng" double precision NOT NULL,
	"bounds_sw_lat" double precision NOT NULL,
	"bounds_sw_lng" double precision NOT NULL,
	"bounds_ne_lat" double precision NOT NULL,
	"bounds_ne_lng" double precision NOT NULL,
	"status" "network_status" DEFAULT 'beta' NOT NULL
);
--> statement-breakpoint

-- All data that exists before this migration is Berlin's. The bounds match the defaults the web
-- frontend has been compiled with, so nothing moves on the map.
INSERT INTO "networks" (
	"id", "name", "country_code", "timezone",
	"center_lat", "center_lng",
	"bounds_sw_lat", "bounds_sw_lng", "bounds_ne_lat", "bounds_ne_lng",
	"status"
) VALUES (
	'berlin', 'Berlin', 'DE', 'Europe/Berlin',
	52.5162, 13.388,
	52.23115511676795, 12.8364646484805, 52.77063424239867, 14.00044556529124,
	'active'
) ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

-- Add the column nullable, backfill, then enforce. Doing it in one step would fail on any
-- deployment that already has rows.
ALTER TABLE "stations" ADD COLUMN "network_id" varchar(32);--> statement-breakpoint
UPDATE "stations" SET "network_id" = 'berlin' WHERE "network_id" IS NULL;--> statement-breakpoint
ALTER TABLE "stations" ALTER COLUMN "network_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "lines" ADD COLUMN "network_id" varchar(32);--> statement-breakpoint
UPDATE "lines" SET "network_id" = 'berlin' WHERE "network_id" IS NULL;--> statement-breakpoint
ALTER TABLE "lines" ALTER COLUMN "network_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "line_stations" ADD COLUMN "network_id" varchar(32);--> statement-breakpoint
UPDATE "line_stations" SET "network_id" = 'berlin' WHERE "network_id" IS NULL;--> statement-breakpoint
ALTER TABLE "line_stations" ALTER COLUMN "network_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "reports" ADD COLUMN "network_id" varchar(32);--> statement-breakpoint
UPDATE "reports" SET "network_id" = 'berlin' WHERE "network_id" IS NULL;--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "network_id" SET NOT NULL;--> statement-breakpoint

-- The foreign keys that point at the old single column `lines` primary key have to go before that
-- key can be replaced.
ALTER TABLE "line_stations" DROP CONSTRAINT "line_stations_line_id_lines_id_fk";--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT "reports_line_id_lines_id_fk";--> statement-breakpoint

ALTER TABLE "lines" DROP CONSTRAINT "lines_pkey";--> statement-breakpoint
ALTER TABLE "lines" ADD CONSTRAINT "lines_network_id_id_pk" PRIMARY KEY("network_id","id");--> statement-breakpoint

ALTER TABLE "line_stations" DROP CONSTRAINT "line_stations_line_id_station_id_pk";--> statement-breakpoint
ALTER TABLE "line_stations" ADD CONSTRAINT "line_stations_network_id_line_id_station_id_pk" PRIMARY KEY("network_id","line_id","station_id");--> statement-breakpoint

ALTER TABLE "stations" ADD CONSTRAINT "stations_network_id_networks_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."networks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lines" ADD CONSTRAINT "lines_network_id_networks_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."networks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_network_id_networks_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."networks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- `stations.id` is globally unique, so a plain `station_id -> stations(id)` foreign key cannot tell
-- whether the station belongs to the referencing row's network. This extra unique key gives the
-- composite foreign keys below a target, which closes that hole.
ALTER TABLE "stations" ADD CONSTRAINT "stations_network_id_id_unique" UNIQUE("network_id","id");--> statement-breakpoint

ALTER TABLE "line_stations" DROP CONSTRAINT "line_stations_station_id_stations_id_fk";--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT "reports_station_id_stations_id_fk";--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT "reports_direction_id_stations_id_fk";--> statement-breakpoint

ALTER TABLE "line_stations" ADD CONSTRAINT "line_stations_network_id_line_id_lines_network_id_id_fk" FOREIGN KEY ("network_id","line_id") REFERENCES "public"."lines"("network_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_stations" ADD CONSTRAINT "line_stations_network_id_station_id_stations_network_id_id_fk" FOREIGN KEY ("network_id","station_id") REFERENCES "public"."stations"("network_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_network_id_station_id_stations_network_id_id_fk" FOREIGN KEY ("network_id","station_id") REFERENCES "public"."stations"("network_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A null `line_id` or `direction_id` skips its check (MATCH SIMPLE): a report without a line or
-- direction stays valid, one that borrows another network's line or direction does not.
ALTER TABLE "reports" ADD CONSTRAINT "reports_network_id_line_id_lines_network_id_id_fk" FOREIGN KEY ("network_id","line_id") REFERENCES "public"."lines"("network_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_network_id_direction_id_stations_network_id_id_fk" FOREIGN KEY ("network_id","direction_id") REFERENCES "public"."stations"("network_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "reports_network_id_timestamp_idx" ON "reports" USING btree ("network_id","timestamp");--> statement-breakpoint
CREATE INDEX "stations_network_id_idx" ON "stations" USING btree ("network_id");
