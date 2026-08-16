import { and, asc, count, desc, eq } from 'drizzle-orm'

import { db } from '../src/db'
import { lineStations } from '../src/db/schema/lines'
import { stations } from '../src/db/schema/stations'
import { app } from '../src/index'
import { DEFAULT_NETWORK_ID } from '../src/modules/networks/constants'

/**
 * Fixture lookups, scoped to the default network.
 *
 * The seed contains every network that ships data, so an unscoped `select ... from stations limit 1`
 * returns whichever city sorts first and then fails a foreign key when written back as a Berlin
 * report. Tests that are not themselves about networks should say which one they mean, once, here.
 */
/**
 * The default network's longest line.
 *
 * Ordered rather than "whichever row comes back first", because a `limit` without an `order by`
 * returns rows in whatever order the table happens to hold them, and the seed rewrites that table
 * from a generated file. Correcting the station order of Berlin's lines was enough to change which
 * line came first, from `S1` with 35 stations to `12` with 24, and the prediction tests started
 * failing on data that is not what they are about.
 *
 * Longest rather than alphabetically first, because the tests that predict reports need a line with
 * enough stations to seed a history on and to tell several predictions apart.
 */
export const pickLineId = async (): Promise<string> => {
    const [line] = await db
        .select({ id: lineStations.lineId, stationCount: count() })
        .from(lineStations)
        .where(eq(lineStations.networkId, DEFAULT_NETWORK_ID))
        .groupBy(lineStations.lineId)
        .orderBy(desc(count()), asc(lineStations.lineId))
        .limit(1)

    return line!.id
}

export const pickStationIds = async (limit: number): Promise<string[]> => {
    const rows = await db
        .select({ id: stations.id })
        .from(stations)
        .where(eq(stations.networkId, DEFAULT_NETWORK_ID))
        .orderBy(asc(stations.id))
        .limit(limit)

    return rows.map((row) => row.id)
}

export const pickStationIdsOnLine = async (lineId: string, limit: number): Promise<string[]> => {
    const rows = await db
        .select({ stationId: lineStations.stationId })
        .from(lineStations)
        .where(and(eq(lineStations.networkId, DEFAULT_NETWORK_ID), eq(lineStations.lineId, lineId)))
        .orderBy(asc(lineStations.stationId))
        .limit(limit)

    return rows.map((row) => row.stationId)
}

export const sendReportRequest = async (payload: object) => {
    return app.request('/v0/reports', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Password': process.env.REPORT_PASSWORD ?? '',
        },
        body: JSON.stringify(payload),
    })
}
