import { boolean, foreignKey, integer, pgEnum, pgTable, primaryKey, varchar } from 'drizzle-orm/pg-core'

import { networks } from './networks'
import { stations } from './stations'

/**
 * What kind of vehicle runs on a line, taken from the route's OpenStreetMap `route` tag.
 *
 * Clients used to derive this from the line's name, where `S` meant suburban rail and a bare number
 * meant tram. That is a Berlin naming convention rather than a fact: Munich's `S1` and Karlsruhe's
 * `S1` are different modes of transport. `unknown` covers a line OpenStreetMap has no route relation
 * for, and is rendered neutrally instead of guessed at.
 */
export const lineModeEnum = pgEnum('line_mode', ['subway', 'light_rail', 'tram', 'train', 'unknown'])

/**
 * Line ids are only unique within a network, not across networks: `S1`, `U6` and `M10` all exist
 * in more than one German city, and `12` is a tram line in a dozen of them.
 *
 * Hence the composite primary key `(networkId, id)`. We deliberately did not prefix the id
 * (`berlin:S1`) because the id is also what users see on the vehicle. Every API response is scoped
 * to a single network, so `S1` stays unambiguous on the wire while the database keeps the two
 * apart.
 */
export const lines = pgTable(
    'lines',
    {
        networkId: varchar({ length: 32 })
            .notNull()
            .references(() => networks.id),
        /** The line designation as printed on the vehicle, for example `S1` or `M10`. */
        id: varchar({ length: 16 }).notNull(),
        name: varchar({ length: 255 }).notNull(),
        /**
         * A line whose first and last station are the same, such as Berlin's Ringbahn. Direction of
         * travel means something different there, so clients and the report inference treat it
         * specially. Derived from the station order when seeding rather than declared by hand.
         */
        isCircular: boolean().notNull().default(false),
        /** Lowercase six digit hex colour, from the route's OpenStreetMap `colour` tag. */
        color: varchar({ length: 7 }).notNull().default('#000000'),
        mode: lineModeEnum().notNull().default('unknown'),
    },
    (table) => [primaryKey({ columns: [table.networkId, table.id] })]
)

/**
 * The ordered stations of a line. `order` defines the direction of travel, so the first and last
 * entry are the line's termini, which is how a reported mid route direction gets normalised.
 */
export const lineStations = pgTable(
    'line_stations',
    {
        networkId: varchar({ length: 32 }).notNull(),
        lineId: varchar({ length: 16 }).notNull(),
        stationId: varchar({ length: 16 }).notNull(),
        order: integer().notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.networkId, table.lineId, table.stationId] }),
        foreignKey({
            columns: [table.networkId, table.lineId],
            foreignColumns: [lines.networkId, lines.id],
        }).onDelete('cascade'),
        /* Both foreign keys carry the network, so a line can only ever be built from stations of
           its own network. */
        foreignKey({
            columns: [table.networkId, table.stationId],
            foreignColumns: [stations.networkId, stations.id],
        }).onDelete('cascade'),
    ]
)
