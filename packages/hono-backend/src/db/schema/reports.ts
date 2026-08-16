import { foreignKey, index, pgTable, varchar, serial, timestamp, pgEnum } from 'drizzle-orm/pg-core'
import { createInsertSchema } from 'drizzle-zod'
import { z } from 'zod'

import { lines } from './lines'
import { networks } from './networks'
import { stations } from './stations'

export const sourceEnum = pgEnum('source', ['mini_app', 'web_app', 'mobile_app', 'telegram'])

/**
 * `networkId` is redundant in the strict sense, since it follows from `stationId`. We store it
 * anyway because every read filters on it: without the column, listing one network's reports for
 * the last hour would mean joining `stations` on every request.
 *
 * It also lets the composite foreign keys below enforce the property that actually matters, namely
 * that a report's station, direction and line all belong to the same network as the report itself.
 * Plain foreign keys cannot do that: `stations.id` is globally unique, so `stationId -> stations.id`
 * would happily accept a Berlin station on a report claiming to be from Hamburg.
 */
export const reports = pgTable(
    'reports',
    {
        reportId: serial().primaryKey(),
        networkId: varchar({ length: 32 })
            .notNull()
            .references(() => networks.id),
        stationId: varchar({ length: 16 }).notNull(),
        lineId: varchar({ length: 16 }),
        directionId: varchar({ length: 16 }),
        timestamp: timestamp().notNull().defaultNow(),
        source: sourceEnum().notNull(),
    },
    (table) => [
        // Every reports query filters by network and time range, in that order.
        index('reports_network_id_timestamp_idx').on(table.networkId, table.timestamp),
        foreignKey({
            columns: [table.networkId, table.stationId],
            foreignColumns: [stations.networkId, stations.id],
        }),
        /* A null `lineId` or `directionId` skips its check (SQL MATCH SIMPLE), which is what we
           want: a report without a line or direction is valid, one that borrows another network's
           line or direction is not. */
        foreignKey({
            columns: [table.networkId, table.lineId],
            foreignColumns: [lines.networkId, lines.id],
        }),
        foreignKey({
            columns: [table.networkId, table.directionId],
            foreignColumns: [stations.networkId, stations.id],
        }),
    ]
)

const insertReportDbSchema = createInsertSchema(reports).pick({
    networkId: true,
    stationId: true,
    lineId: true,
    directionId: true,
    source: true,
})

/* API input schema:
   - Allows missing stationId (bot sometimes cannot detect it)
   - Allows missing source (we default to telegram)
   - Requires at least one of stationId, lineId, or directionId
   - Omits networkId, which the server resolves for the request rather than trusting the client */
export const insertReportSchema = insertReportDbSchema
    .omit({ networkId: true })
    .extend({
        source: insertReportDbSchema.shape.source.optional(),
        stationId: insertReportDbSchema.shape.stationId.optional(),
    })
    .superRefine((data, ctx) => {
        if (data.stationId === undefined && data.lineId === undefined && data.directionId === undefined) {
            ctx.addIssue({
                code: 'custom',
                message: 'At least one of stationId, lineId, or directionId must be provided',
                path: [],
            })
        }
    })

// Database insert type (internal use): networkId + stationId + source are required
export type InsertReport = z.infer<typeof insertReportDbSchema>
