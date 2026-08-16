import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { DateTime, Settings } from 'luxon'

import { db, lines, lineStations, networks, reports, stations } from '../src/db'
import { app } from '../src/index'

/**
 * Predictions reason about the time of day, so they have to be read on the clock of the city the
 * network serves, never on the server's.
 *
 * Two things depend on it, and both are covered here: the threshold curve that decides how many
 * predicted reports a request gets, and the hour buckets `guessStation` compares history against.
 *
 * These tests deliberately do not call `seedBaseData`. They bring their own networks, so the real
 * city data would only add runtime and a dependency on files they do not use.
 */

const WEST_NETWORK_ID = 'test-tz-west'
const EAST_NETWORK_ID = 'test-tz-east'
const TEST_NETWORK_IDS = [WEST_NETWORK_ID, EAST_NETWORK_ID]

const WEST_LINE_ID = 'TZW1'
const STATIONS_PER_NETWORK = 8

const stationIdsOf = (networkId: string): string[] =>
    Array.from(
        { length: STATIONS_PER_NETWORK },
        (_, index) => `${networkId === WEST_NETWORK_ID ? 'TZW' : 'TZE'}-${index}`
    )

const westStationIds = stationIdsOf(WEST_NETWORK_ID)
const eastStationIds = stationIdsOf(EAST_NETWORK_ID)

const insertNetwork = async (id: string, timezone: string) => {
    await db.insert(networks).values({
        id,
        name: id,
        countryCode: 'DE',
        timezone,
        centerLat: 52.52,
        centerLng: 13.405,
        boundsSwLat: 52.3,
        boundsSwLng: 13.0,
        boundsNeLat: 52.7,
        boundsNeLng: 13.8,
        // Predictions are only served for an active network.
        status: 'active',
    })

    await db.insert(stations).values(
        stationIdsOf(id).map((stationId, index) => ({
            id: stationId,
            networkId: id,
            name: stationId,
            lat: 52.52 + index * 0.001,
            lng: 13.405 + index * 0.001,
        }))
    )
}

const removeTestNetworks = async () => {
    await db.delete(reports).where(inArray(reports.networkId, TEST_NETWORK_IDS))
    await db.delete(lineStations).where(inArray(lineStations.networkId, TEST_NETWORK_IDS))
    await db.delete(lines).where(inArray(lines.networkId, TEST_NETWORK_IDS))
    await db.delete(stations).where(inArray(stations.networkId, TEST_NETWORK_IDS))
    await db.delete(networks).where(inArray(networks.id, TEST_NETWORK_IDS))
}

/* History two weeks back, so it never falls into a queried window and can only ever show up as the
   material a prediction is built from. Every hour of the day is dominated by a different station,
   which is what lets a request reach more than one predicted station at all. */
const seedHourlyHistory = async (networkId: string, stationIds: string[]) => {
    const start = DateTime.fromISO('2024-01-01T00:00:00Z', { zone: 'utc' })

    const rows = []
    for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
        for (let hour = 0; hour < 24; hour++) {
            rows.push({
                networkId,
                stationId: stationIds[hour % stationIds.length]!,
                source: 'telegram' as const,
                timestamp: start.plus({ days: dayOffset, hours: hour }).toJSDate(),
            })
        }
    }

    await db.insert(reports).values(rows)
}

const fetchReports = async (networkId: string, from: DateTime, to: DateTime) => {
    const range = `from=${encodeURIComponent(from.toISO()!)}&to=${encodeURIComponent(to.toISO()!)}`
    const response = await app.request(`/v0/reports?network=${networkId}&${range}`)

    expect(response.status).toBe(200)

    return (await response.json()) as Array<{ stationId: string; isPredicted: boolean }>
}

describe('Network timezone drives predictions', () => {
    let previousReportPassword: string | undefined

    beforeAll(async () => {
        /* Posting a report goes through the anti spam check, which the password short circuits.
           Restored afterwards because the environment is shared with every other test file. */
        previousReportPassword = process.env.REPORT_PASSWORD
        process.env.REPORT_PASSWORD = 'test-password'

        await removeTestNetworks()

        // Same country in the fixture, different clocks: only the timezone may explain a difference.
        await insertNetwork(WEST_NETWORK_ID, 'Europe/Berlin')
        await insertNetwork(EAST_NETWORK_ID, 'Asia/Tokyo')

        await db.insert(lines).values({ id: WEST_LINE_ID, networkId: WEST_NETWORK_ID, name: WEST_LINE_ID })
        await db.insert(lineStations).values([
            { networkId: WEST_NETWORK_ID, lineId: WEST_LINE_ID, stationId: westStationIds[0]!, order: 0 },
            { networkId: WEST_NETWORK_ID, lineId: WEST_LINE_ID, stationId: westStationIds[1]!, order: 1 },
        ])
    })

    beforeEach(async () => {
        await db.delete(reports).where(inArray(reports.networkId, TEST_NETWORK_IDS))
    })

    afterEach(async () => {
        await db.delete(reports).where(inArray(reports.networkId, TEST_NETWORK_IDS))
        /* `Settings.now` is process global. Leaving a mock behind would move time for every test
           that runs after this one. */
        Settings.now = () => Date.now()
    })

    afterAll(async () => {
        await removeTestNetworks()

        if (previousReportPassword === undefined) {
            delete process.env.REPORT_PASSWORD
        } else {
            process.env.REPORT_PASSWORD = previousReportPassword
        }
    })

    it('reads the threshold curve on the network clock, not the server clock', async () => {
        await seedHourlyHistory(WEST_NETWORK_ID, westStationIds)
        await seedHourlyHistory(EAST_NETWORK_ID, eastStationIds)

        /* One instant, two cities. 02:00 UTC on a Monday is the dead of night in Berlin (03:00,
           threshold 1) and late morning in Tokyo (11:00, threshold 7). Evaluated on a UTC server
           both would get the night threshold. */
        const now = DateTime.fromISO('2024-01-15T02:00:00Z', { zone: 'utc' })
        Settings.now = () => now.toMillis()

        const from = now.minus({ hours: 12 })
        const to = now.plus({ hours: 12 })

        const berlinReports = await fetchReports(WEST_NETWORK_ID, from, to)
        const tokyoReports = await fetchReports(EAST_NETWORK_ID, from, to)

        expect(berlinReports.every((report) => report.isPredicted)).toBe(true)
        expect(tokyoReports.every((report) => report.isPredicted)).toBe(true)

        expect(berlinReports.length).toBe(1)
        expect(tokyoReports.length).toBeGreaterThan(berlinReports.length)
        expect(tokyoReports.length).toBeGreaterThanOrEqual(3)
    })

    it('buckets historic reports by local hour across a daylight saving change', async () => {
        /* Both stations are reported on the same weekday, one at 12:00 local, one at 11:00 local.
           The history is from January (UTC+1 in Berlin), the request is in July (UTC+2), so the two
           clocks disagree by exactly one hour. Read in UTC, 12:00 local in July lines up with the
           11:00 station; read in Berlin time it lines up with the 12:00 one. */
        const januaryMonday = DateTime.fromISO('2024-01-15T00:00:00Z', { zone: 'utc' })
        const expectedStationId = westStationIds[0]!
        const decoyStationId = westStationIds[1]!

        const history = []
        for (let index = 0; index < 4; index++) {
            history.push({
                networkId: WEST_NETWORK_ID,
                stationId: expectedStationId,
                lineId: WEST_LINE_ID,
                source: 'telegram' as const,
                // 11:00 UTC is 12:00 in Berlin in January.
                timestamp: januaryMonday.plus({ hours: 11, minutes: index }).toJSDate(),
            })
        }
        // The decoy is reported more often, so only the hour it was reported in can rule it out.
        for (let index = 0; index < 10; index++) {
            history.push({
                networkId: WEST_NETWORK_ID,
                stationId: decoyStationId,
                lineId: WEST_LINE_ID,
                source: 'telegram' as const,
                timestamp: januaryMonday.plus({ hours: 10, minutes: index }).toJSDate(),
            })
        }
        await db.insert(reports).values(history)

        // A July Monday, 12:00 in Berlin, which is 10:00 UTC.
        const julyMondayNoonBerlin = DateTime.fromISO('2024-07-15T10:00:00Z', { zone: 'utc' })
        Settings.now = () => julyMondayNoonBerlin.toMillis()

        const response = await app.request(`/v0/reports?network=${WEST_NETWORK_ID}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Password': process.env.REPORT_PASSWORD ?? '' },
            body: JSON.stringify({ lineId: WEST_LINE_ID, source: 'web_app' }),
        })

        expect(response.status).toBe(200)

        const body = (await response.json()) as { stationId: string }
        expect(body.stationId).toBe(expectedStationId)
    })

    it('falls back to UTC instead of failing when a network carries an unusable timezone', async () => {
        await seedHourlyHistory(WEST_NETWORK_ID, westStationIds)
        await db.update(networks).set({ timezone: 'Mars/Olympus_Mons' }).where(eq(networks.id, WEST_NETWORK_ID))

        try {
            const now = DateTime.fromISO('2024-01-15T12:00:00Z', { zone: 'utc' })
            Settings.now = () => now.toMillis()

            const body = await fetchReports(WEST_NETWORK_ID, now.minus({ hours: 12 }), now.plus({ hours: 12 }))

            // Serving the curve an hour off beats serving nothing at all.
            expect(body.length).toBeGreaterThan(0)
        } finally {
            await db.update(networks).set({ timezone: 'Europe/Berlin' }).where(eq(networks.id, WEST_NETWORK_ID))
        }
    })
})
