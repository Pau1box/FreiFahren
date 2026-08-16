import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { DateTime } from 'luxon'

import { db, lines, lineStations, networks, reports, stations } from '../src/db'
import { seedBaseData } from '../src/db/seed/seed'
import { app } from '../src/index'
import { DEFAULT_NETWORK_ID } from '../src/modules/networks/constants'

/**
 * These tests are about the one property the schema exists to guarantee: two networks can use the
 * same line designation, and nothing can mix them up.
 *
 * The first block works directly against the database, because those constraints are what every
 * layer above relies on. The second block goes through the API and covers the two promises the
 * routes make: a request can pick its network, and a request that does not pick one still behaves
 * exactly as it did before multi network support existed.
 */

// A second, deliberately minimal network. `U8` collides with Berlin's U8, which is the point.
const OTHER_NETWORK_ID = 'test-hamburg'
const OTHER_LINE_ID = 'U8'
const OTHER_STATION_ID = 'TEST-U-n9999'

let berlinStationId: string

const removeTestNetwork = async () => {
    await db.delete(reports).where(eq(reports.networkId, OTHER_NETWORK_ID))
    await db.delete(lineStations).where(eq(lineStations.networkId, OTHER_NETWORK_ID))
    await db.delete(lines).where(eq(lines.networkId, OTHER_NETWORK_ID))
    await db.delete(stations).where(eq(stations.networkId, OTHER_NETWORK_ID))
    await db.delete(networks).where(eq(networks.id, OTHER_NETWORK_ID))
}

/* Historic rows the prediction can reason from. They sit well outside the window the tests query,
   so they never show up as real reports, only as the material predictions are built from. */
const seedHistoryFor = async (networkId: string) => {
    for (let i = 0; i < 20; i++) {
        await db.insert(reports).values({
            networkId,
            stationId: OTHER_STATION_ID,
            source: 'telegram',
            timestamp: DateTime.utc()
                .minus({ days: 3, minutes: i * 7 })
                .toJSDate(),
        })
    }
}

/* A short window that contains no real reports, so anything the API returns has to be predicted. */
const fetchReportsInEmptyWindow = async (networkId: string) => {
    const now = DateTime.utc()
    const range =
        `from=${encodeURIComponent(now.minus({ minutes: 5 }).toISO()!)}` +
        `&to=${encodeURIComponent(now.plus({ minutes: 5 }).toISO()!)}`

    const response = await app.request(`/v0/reports?network=${networkId}&${range}`)
    expect(response.status).toBe(200)

    return (await response.json()) as Array<{ stationId: string; isPredicted: boolean }>
}

describe('Multi network schema', () => {
    beforeAll(async () => {
        await seedBaseData(db)
        await removeTestNetwork()

        const [station] = await db
            .select({ id: stations.id })
            .from(stations)
            .where(eq(stations.networkId, DEFAULT_NETWORK_ID))
            .limit(1)
        berlinStationId = station.id

        await db.insert(networks).values({
            id: OTHER_NETWORK_ID,
            name: 'Test Hamburg',
            countryCode: 'DE',
            timezone: 'Europe/Berlin',
            centerLat: 53.5511,
            centerLng: 9.9937,
            boundsSwLat: 53.39,
            boundsSwLng: 9.73,
            boundsNeLat: 53.74,
            boundsNeLng: 10.32,
            status: 'beta',
        })
        await db.insert(stations).values({
            id: OTHER_STATION_ID,
            networkId: OTHER_NETWORK_ID,
            name: 'Jungfernstieg',
            lat: 53.5527,
            lng: 9.9936,
        })
        await db.insert(lines).values({
            id: OTHER_LINE_ID,
            networkId: OTHER_NETWORK_ID,
            name: OTHER_LINE_ID,
        })
    })

    afterAll(removeTestNetwork)

    it('lets two networks use the same line designation', async () => {
        const rows = await db.select({ networkId: lines.networkId, id: lines.id }).from(lines)

        // Both must carry the line. Not an exact list: real German networks share designations too,
        // Munich has a U8 as well, and a third holder of the name proves the same point.
        const holders = new Set(rows.filter((row) => row.id === OTHER_LINE_ID).map((row) => row.networkId))
        expect(holders.has(DEFAULT_NETWORK_ID)).toBe(true)
        expect(holders.has(OTHER_NETWORK_ID)).toBe(true)
    })

    it('rejects a report that claims one network but names a station from another', async () => {
        const insert = async () =>
            db.insert(reports).values({
                networkId: OTHER_NETWORK_ID,
                stationId: berlinStationId,
                lineId: null,
                source: 'telegram',
            })

        await expect(insert()).rejects.toThrow()
    })

    it('rejects a report that borrows a direction from another network', async () => {
        const insert = async () =>
            db.insert(reports).values({
                networkId: OTHER_NETWORK_ID,
                stationId: OTHER_STATION_ID,
                directionId: berlinStationId,
                source: 'telegram',
            })

        await expect(insert()).rejects.toThrow()
    })

    it('rejects putting a station from another network on a line', async () => {
        const insert = async () =>
            db.insert(lineStations).values({
                networkId: OTHER_NETWORK_ID,
                lineId: OTHER_LINE_ID,
                stationId: berlinStationId,
                order: 0,
            })

        await expect(insert()).rejects.toThrow()
    })

    it('rejects a report for a network that does not exist', async () => {
        const insert = async () =>
            db.insert(reports).values({
                networkId: 'no-such-network',
                stationId: OTHER_STATION_ID,
                source: 'telegram',
            })

        await expect(insert()).rejects.toThrow()
    })

    it('accepts a report that stays inside one network', async () => {
        const [report] = await db
            .insert(reports)
            .values({
                networkId: OTHER_NETWORK_ID,
                stationId: OTHER_STATION_ID,
                lineId: OTHER_LINE_ID,
                source: 'telegram',
            })
            .returning({ networkId: reports.networkId, lineId: reports.lineId })

        expect(report).toEqual({ networkId: OTHER_NETWORK_ID, lineId: OTHER_LINE_ID })
    })

    it('accepts a report without a line or direction', async () => {
        const [report] = await db
            .insert(reports)
            .values({
                networkId: OTHER_NETWORK_ID,
                stationId: OTHER_STATION_ID,
                source: 'telegram',
            })
            .returning({ lineId: reports.lineId, directionId: reports.directionId })

        expect(report).toEqual({ lineId: null, directionId: null })
    })
})

describe('Network scoped API', () => {
    beforeAll(async () => {
        await seedBaseData(db)
        await removeTestNetwork()

        await db.insert(networks).values({
            id: OTHER_NETWORK_ID,
            name: 'Test Hamburg',
            countryCode: 'DE',
            timezone: 'Europe/Berlin',
            centerLat: 53.5511,
            centerLng: 9.9937,
            boundsSwLat: 53.39,
            boundsSwLng: 9.73,
            boundsNeLat: 53.74,
            boundsNeLng: 10.32,
            status: 'beta',
            serves: ['Norderstedt'],
        })
        await db.insert(stations).values([
            {
                id: OTHER_STATION_ID,
                networkId: OTHER_NETWORK_ID,
                name: 'Jungfernstieg',
                lat: 53.5527,
                lng: 9.9936,
            },
            {
                id: `${OTHER_STATION_ID}-b`,
                networkId: OTHER_NETWORK_ID,
                name: 'Wandsbek Markt',
                lat: 53.5717,
                lng: 10.0669,
            },
        ])
        await db.insert(lines).values({ id: OTHER_LINE_ID, networkId: OTHER_NETWORK_ID, name: OTHER_LINE_ID })
        await db.insert(lineStations).values([
            { networkId: OTHER_NETWORK_ID, lineId: OTHER_LINE_ID, stationId: OTHER_STATION_ID, order: 0 },
            { networkId: OTHER_NETWORK_ID, lineId: OTHER_LINE_ID, stationId: `${OTHER_STATION_ID}-b`, order: 1 },
        ])
    })

    afterAll(removeTestNetwork)

    it('lists every network with the geography a client needs', async () => {
        const response = await app.request('/v0/networks')
        expect(response.status).toBe(200)

        const body = (await response.json()) as Array<{ id: string; status: string; bounds: unknown }>
        const berlin = body.find((network) => network.id === DEFAULT_NETWORK_ID)

        expect(berlin).toBeDefined()
        expect(berlin).toMatchObject({
            id: DEFAULT_NETWORK_ID,
            name: 'Berlin',
            countryCode: 'DE',
            timezone: 'Europe/Berlin',
            status: 'active',
        })
        expect(berlin!.bounds).toEqual({
            southWest: { latitude: 52.23115511676795, longitude: 12.8364646484805 },
            northEast: { latitude: 52.77063424239867, longitude: 14.00044556529124 },
        })
        expect(body.map((network) => network.id)).toContain(OTHER_NETWORK_ID)
    })

    it('names the other cities a network serves, so a rider can find it by their own city', async () => {
        const response = await app.request('/v0/networks')
        const body = (await response.json()) as Array<{ id: string; serves: string[] }>

        // A network is named after one city and often serves a dozen. Without this a rider in
        // Dortmund cannot tell that the network filed under Duesseldorf is the one they are in.
        expect(body.find((network) => network.id === OTHER_NETWORK_ID)?.serves).toEqual(['Norderstedt'])

        // Always an array, never null: a client filters on it without a special case for a network
        // that serves only its own city.
        expect(body.every((network) => Array.isArray(network.serves))).toBe(true)
    })

    it('returns only the stations of the requested network', async () => {
        const response = await app.request(`/v0/transit/stations?network=${OTHER_NETWORK_ID}`)
        expect(response.status).toBe(200)

        const body = (await response.json()) as Record<string, { lines: string[] }>
        expect(Object.keys(body).sort()).toEqual([OTHER_STATION_ID, `${OTHER_STATION_ID}-b`].sort())
    })

    it('resolves the same line id differently per network', async () => {
        const other = (await (await app.request(`/v0/transit/lines?network=${OTHER_NETWORK_ID}`)).json()) as Record<
            string,
            string[]
        >
        const berlin = (await (await app.request(`/v0/transit/lines?network=${DEFAULT_NETWORK_ID}`)).json()) as Record<
            string,
            string[]
        >

        expect(Object.keys(other)).toEqual([OTHER_LINE_ID])
        expect(other[OTHER_LINE_ID]).toEqual([OTHER_STATION_ID, `${OTHER_STATION_ID}-b`])
        // Berlin has a U8 too, and it is a completely different line.
        expect(berlin[OTHER_LINE_ID]!.length).toBeGreaterThan(2)
        expect(berlin[OTHER_LINE_ID]).not.toContain(OTHER_STATION_ID)
    })

    it('treats a missing network parameter as the default network', async () => {
        const withoutParam = await (await app.request('/v0/transit/stations')).json()
        const withParam = await (await app.request(`/v0/transit/stations?network=${DEFAULT_NETWORK_ID}`)).json()

        expect(withoutParam).toEqual(withParam)
    })

    it('answers with 404 for an unknown network', async () => {
        const response = await app.request('/v0/transit/stations?network=atlantis')
        expect(response.status).toBe(404)

        const body = (await response.json()) as { details: { internal_code: string } }
        expect(body.details.internal_code).toBe('NETWORK_NOT_FOUND')
    })

    it('never returns reports from another network', async () => {
        await db.delete(reports)
        const [inserted] = await db
            .insert(reports)
            .values({
                networkId: OTHER_NETWORK_ID,
                stationId: OTHER_STATION_ID,
                lineId: OTHER_LINE_ID,
                source: 'telegram',
            })
            .returning({ timestamp: reports.timestamp })

        /* An explicit range rather than the default one. Luxon's `Settings.now` is a global that
           other suites mock to a fixed date, so relying on "the last hour" would make this test
           depend on the order test files happen to run in. */
        const insertedAt = DateTime.fromJSDate(inserted.timestamp, { zone: 'utc' })
        const range =
            `from=${encodeURIComponent(insertedAt.minus({ minutes: 1 }).toISO()!)}` +
            `&to=${encodeURIComponent(insertedAt.plus({ minutes: 1 }).toISO()!)}`

        const otherReports = (await (
            await app.request(`/v0/reports?network=${OTHER_NETWORK_ID}&${range}`)
        ).json()) as Array<{ stationId: string; isPredicted: boolean }>
        const berlinReports = (await (
            await app.request(`/v0/reports?network=${DEFAULT_NETWORK_ID}&${range}`)
        ).json()) as Array<{ stationId: string; isPredicted: boolean }>

        expect(otherReports.filter((report) => !report.isPredicted).map((report) => report.stationId)).toEqual([
            OTHER_STATION_ID,
        ])
        expect(berlinReports.filter((report) => !report.isPredicted)).toEqual([])

        // Predictions must stay inside their network too, otherwise a quiet city would be filled
        // up with invented reports borrowed from a busy one.
        const otherStationIds = new Set([OTHER_STATION_ID, `${OTHER_STATION_ID}-b`])
        expect(otherReports.every((report) => otherStationIds.has(report.stationId))).toBe(true)
        expect(berlinReports.every((report) => !otherStationIds.has(report.stationId))).toBe(true)

        await db.delete(reports)
    })

    it('rejects a report whose station belongs to a different network', async () => {
        const response = await app.request(`/v0/reports?network=${OTHER_NETWORK_ID}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Password': process.env.REPORT_PASSWORD ?? '' },
            body: JSON.stringify({ stationId: berlinStationId, source: 'web_app' }),
        })

        expect(response.status).toBe(422)

        const body = (await response.json()) as { message: string }
        expect(body.message).toContain('stationId')
        expect(body.message).toContain(OTHER_NETWORK_ID)
    })

    it('accepts a report that stays inside the requested network', async () => {
        const response = await app.request(`/v0/reports?network=${OTHER_NETWORK_ID}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Password': process.env.REPORT_PASSWORD ?? '' },
            body: JSON.stringify({ stationId: OTHER_STATION_ID, lineId: OTHER_LINE_ID, source: 'web_app' }),
        })

        expect(response.status).toBe(200)

        const [stored] = await db.select().from(reports).where(eq(reports.networkId, OTHER_NETWORK_ID))
        expect(stored).toMatchObject({ networkId: OTHER_NETWORK_ID, stationId: OTHER_STATION_ID })

        await db.delete(reports)
    })
})

describe('Network scoped inference and predictions', () => {
    let berlinStationOnSharedLine: string

    const postReportTo = (networkId: string, body: object) =>
        app.request(`/v0/reports?network=${networkId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Password': process.env.REPORT_PASSWORD ?? '' },
            body: JSON.stringify(body),
        })

    beforeAll(async () => {
        await seedBaseData(db)
        await removeTestNetwork()

        await db.insert(networks).values({
            id: OTHER_NETWORK_ID,
            name: 'Test Hamburg',
            countryCode: 'DE',
            timezone: 'Europe/Berlin',
            centerLat: 53.5511,
            centerLng: 9.9937,
            boundsSwLat: 53.39,
            boundsSwLng: 9.73,
            boundsNeLat: 53.74,
            boundsNeLng: 10.32,
            status: 'beta',
        })
        await db.insert(stations).values([
            { id: OTHER_STATION_ID, networkId: OTHER_NETWORK_ID, name: 'Jungfernstieg', lat: 53.5527, lng: 9.9936 },
            {
                id: `${OTHER_STATION_ID}-b`,
                networkId: OTHER_NETWORK_ID,
                name: 'Wandsbek Markt',
                lat: 53.5717,
                lng: 10.0669,
            },
        ])
        await db.insert(lines).values({ id: OTHER_LINE_ID, networkId: OTHER_NETWORK_ID, name: OTHER_LINE_ID })
        await db.insert(lineStations).values([
            { networkId: OTHER_NETWORK_ID, lineId: OTHER_LINE_ID, stationId: OTHER_STATION_ID, order: 0 },
            { networkId: OTHER_NETWORK_ID, lineId: OTHER_LINE_ID, stationId: `${OTHER_STATION_ID}-b`, order: 1 },
        ])

        // Berlin runs a U8 as well, which is exactly the collision this has to survive.
        const [berlinEntry] = await db
            .select({ stationId: lineStations.stationId })
            .from(lineStations)
            .where(and(eq(lineStations.networkId, DEFAULT_NETWORK_ID), eq(lineStations.lineId, OTHER_LINE_ID)))
            .limit(1)
        berlinStationOnSharedLine = berlinEntry.stationId
    })

    beforeEach(async () => {
        await db.delete(reports)
    })

    afterAll(async () => {
        await db.delete(reports)
        await removeTestNetwork()
    })

    it('does not guess a station from another network for a line both networks run', async () => {
        // Plenty of Berlin history on U8, and none at all for the other network.
        for (let i = 0; i < 10; i++) {
            await db.insert(reports).values({
                networkId: DEFAULT_NETWORK_ID,
                stationId: berlinStationOnSharedLine,
                lineId: OTHER_LINE_ID,
                source: 'telegram',
                timestamp: DateTime.utc().minus({ days: 1, minutes: i }).toJSDate(),
            })
        }

        const response = await postReportTo(OTHER_NETWORK_ID, { lineId: OTHER_LINE_ID, source: 'web_app' })

        // Without a station of its own to guess from, the report is rejected. Borrowing Berlin's
        // busiest U8 station would be worse than admitting we do not know.
        expect(response.status).toBe(422)

        const stored = await db.select().from(reports).where(eq(reports.networkId, OTHER_NETWORK_ID))
        expect(stored).toEqual([])
    })

    it('guesses from the reporting network once that network has history', async () => {
        for (let i = 0; i < 10; i++) {
            await db.insert(reports).values({
                networkId: DEFAULT_NETWORK_ID,
                stationId: berlinStationOnSharedLine,
                lineId: OTHER_LINE_ID,
                source: 'telegram',
                timestamp: DateTime.utc().minus({ days: 1, minutes: i }).toJSDate(),
            })
        }
        await db.insert(reports).values({
            networkId: OTHER_NETWORK_ID,
            stationId: OTHER_STATION_ID,
            lineId: OTHER_LINE_ID,
            source: 'telegram',
            timestamp: DateTime.utc().minus({ days: 1 }).toJSDate(),
        })

        const response = await postReportTo(OTHER_NETWORK_ID, { lineId: OTHER_LINE_ID, source: 'web_app' })

        expect(response.status).toBe(200)

        const body = (await response.json()) as { stationId: string }
        expect(body.stationId).toBe(OTHER_STATION_ID)
        expect(body.stationId).not.toBe(berlinStationOnSharedLine)
    })

    it('rejects a station of another network on the reports by station route', async () => {
        const response = await app.request(`/v0/reports/${OTHER_STATION_ID}?network=${DEFAULT_NETWORK_ID}`)

        /* An empty list would be indistinguishable from "nobody reported anything here" and would
           hide the client's actual mistake, asking with the wrong network selected. */
        expect(response.status).toBe(422)

        const scoped = await app.request(`/v0/reports/${OTHER_STATION_ID}?network=${OTHER_NETWORK_ID}`)
        expect(scoped.status).toBe(200)
    })

    it('shows no predicted reports for a network that is still in beta', async () => {
        await seedHistoryFor(OTHER_NETWORK_ID)

        const body = await fetchReportsInEmptyWindow(OTHER_NETWORK_ID)

        /* A network in beta has no coverage worth reasoning from, so an empty map is the honest
           answer. Inventing inspectors for a city nobody has reported in yet would mislead exactly
           the person we need to keep. */
        expect(body).toEqual([])
    })

    it('shows predicted reports once a network is active', async () => {
        await seedHistoryFor(OTHER_NETWORK_ID)
        await db.update(networks).set({ status: 'active' }).where(eq(networks.id, OTHER_NETWORK_ID))

        try {
            const body = await fetchReportsInEmptyWindow(OTHER_NETWORK_ID)

            expect(body.length).toBeGreaterThan(0)
            expect(body.every((report) => report.isPredicted)).toBe(true)
            expect(body.every((report) => report.stationId.startsWith(OTHER_STATION_ID))).toBe(true)
        } finally {
            await db.update(networks).set({ status: 'beta' }).where(eq(networks.id, OTHER_NETWORK_ID))
        }
    })
})
