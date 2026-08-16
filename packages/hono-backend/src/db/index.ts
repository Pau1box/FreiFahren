import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { feedback } from './schema/feedback'
import { lines, lineStations } from './schema/lines'
import { networks } from './schema/networks'
import { reports } from './schema/reports'
import { stations } from './schema/stations'

const connectionString = process.env.DATABASE_URL!

/* The session runs in UTC, whatever the server is configured with.
   `timestamp` columns carry no zone, so `defaultNow()` stores whatever wall clock the session
   happens to be on, while drizzle reads every such column back as UTC. On a server configured with
   a local zone the two disagree and every report is off by that offset. Pinning the session is the
   one place where that can be settled for reads, writes and defaults alike. */
export const client = postgres(connectionString, { prepare: false, connection: { TimeZone: 'UTC' } })
export const db = drizzle(client, {
    schema: { reports, stations, lines, lineStations, networks, feedback },
    casing: 'snake_case',
})

export type DbConnection = typeof db

export * from './schema/feedback'
export * from './schema/networks'
export * from './schema/reports'
export * from './schema/lines'
export * from './schema/stations'
