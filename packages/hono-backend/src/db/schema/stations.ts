import { doublePrecision, index, pgTable, unique, varchar } from 'drizzle-orm/pg-core'

import { networks } from './networks'

/**
 * Station ids stay globally unique across every network rather than being scoped to one.
 *
 * They are derived from nationally unique sources: DS100 operating point codes for rail stations
 * (`S-BTGN`) and OSM node ids for everything else (`M-n1631224840`). Keeping them global means a
 * report can name a station and the network follows from it, with no ambiguity to resolve.
 *
 * The network data pipeline is responsible for upholding that uniqueness. See the validator in
 * `networks/` for the check that fails a build when two networks claim the same station id.
 */
export const stations = pgTable(
    'stations',
    {
        id: varchar({ length: 16 }).primaryKey(),
        networkId: varchar({ length: 32 })
            .notNull()
            .references(() => networks.id),
        name: varchar({ length: 255 }).notNull(),
        lat: doublePrecision().notNull(),
        lng: doublePrecision().notNull(),
    },
    (table) => [
        index('stations_network_id_idx').on(table.networkId),
        /* Redundant on its own, since `id` is already unique. It exists so that other tables can
           point a composite foreign key at `(networkId, id)` and have the database reject a station
           that belongs to a different network than the row referencing it. Without this, nothing
           would stop a Berlin station from being stored under a Hamburg report. */
        unique('stations_network_id_id_unique').on(table.networkId, table.id),
    ]
)
