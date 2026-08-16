import { doublePrecision, pgEnum, pgTable, varchar } from 'drizzle-orm/pg-core'

/**
 * How much we trust a network's data and coverage.
 *
 * - `active`: enough reports come in for the map to be useful, show it like Berlin.
 * - `beta`: the network data exists but coverage is thin. Clients should say so instead of
 *   presenting an empty map as if nothing were happening.
 */
export const networkStatusEnum = pgEnum('network_status', ['active', 'beta'])

/**
 * A network is one self contained transit system, for example Berlin or Hamburg.
 *
 * It is deliberately a transit area rather than a city: Berlin's S1 runs to Oranienburg and the
 * S7 to Potsdam, both outside the city limits, and those stations belong to the same network as
 * the rest of the line.
 *
 * Every station, line and report belongs to exactly one network. That is what makes `S1`
 * unambiguous: it is only ever resolved inside a single network, never across all of Germany.
 *
 * The geography columns (`center*`, `bounds*`) let a client position its map without shipping a
 * hardcoded coordinate per city, and let it pick a sensible default network from the user's
 * position.
 */
export const networks = pgTable('networks', {
    /** URL and config friendly slug, for example `berlin`. Stable, it appears in API requests. */
    id: varchar({ length: 32 }).primaryKey(),
    /** Human readable name as shown to users, for example `Berlin`. */
    name: varchar({ length: 255 }).notNull(),
    /** ISO 3166-1 alpha-2, for example `DE`. */
    countryCode: varchar({ length: 2 }).notNull(),
    /**
     * IANA timezone, for example `Europe/Berlin`. Report predictions reason about time of day, so
     * they have to do it in the network's local time rather than the server's.
     */
    timezone: varchar({ length: 64 }).notNull(),
    /** Where a client should centre its map when it opens this network. */
    centerLat: doublePrecision().notNull(),
    centerLng: doublePrecision().notNull(),
    /** South west corner of the network's bounding box. */
    boundsSwLat: doublePrecision().notNull(),
    boundsSwLng: doublePrecision().notNull(),
    /** North east corner of the network's bounding box. */
    boundsNeLat: doublePrecision().notNull(),
    boundsNeLng: doublePrecision().notNull(),
    status: networkStatusEnum().notNull().default('beta'),
    /**
     * The other cities this network reaches, generated from the stations it was built with.
     *
     * A network is named after one city and often serves a dozen: the Rhine-Ruhr network is filed
     * under `duesseldorf` and stops in Dortmund, Essen and Duisburg. Without this, someone in
     * Dortmund browsing a list of forty cities has no way to tell that their own is covered.
     */
    serves: varchar({ length: 255 }).array().notNull().default([]),
})
