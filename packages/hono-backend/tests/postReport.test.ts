import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { DateTime } from 'luxon'

import { Stations } from '../src/modules/transit/types'
import { TransitNetworkDataService } from '../src/modules/transit/transit-network-data-service'
import { db, lineStations, reports, stations } from '../src/db'
import { seedBaseData } from '../src/db/seed/seed'
import { and, desc, eq } from 'drizzle-orm'
import { DEFAULT_NETWORK_ID } from '../src/modules/networks/constants'
import { pickLineId, pickStationIds, pickStationIdsOnLine, sendReportRequest } from './test-utils'

let fakeNlpServer: ReturnType<typeof Bun.serve> | null = null
let fakeSecurityServer: ReturnType<typeof Bun.serve> | null = null

type CapturedRequest = {
    body: unknown
    password: string | null
}

const capturedRequests: CapturedRequest[] = []
let securityValidResponse = true

describe('Telegram notification', () => {
    let shouldFail: boolean

    beforeAll(async () => {
        await seedBaseData(db)

        const fakeNlp = new Hono()

        fakeNlp.post('/report-inspector', async (c) => {
            const body = await c.req.json()
            const password = c.req.header('X-Password') ?? null

            capturedRequests.push({ body, password })

            if (shouldFail) {
                return c.json({ status: 'error' }, 500)
            }

            return c.json({ status: 'success' }, 200)
        })

        fakeNlpServer = Bun.serve({
            port: 0,
            fetch: fakeNlp.fetch,
        })

        const fakeSecurity = new Hono()
        fakeSecurity.post('/check', async (c) => {
            return c.json({ valid: securityValidResponse })
        })

        fakeSecurityServer = Bun.serve({
            port: 0,
            fetch: fakeSecurity.fetch,
        })

        process.env.NLP_SERVICE_URL = `http://127.0.0.1:${fakeNlpServer.port}`
        process.env.SECURITY_MICROSERVICE_URL = `http://127.0.0.1:${fakeSecurityServer.port}`
        process.env.REPORT_PASSWORD = 'test-password'
        process.env.NODE_ENV = 'production'
    })

    afterAll(() => {
        fakeNlpServer?.stop()
        fakeSecurityServer?.stop()
    })

    beforeEach(() => {
        capturedRequests.length = 0
        shouldFail = false
        securityValidResponse = true
    })

    it('sends a Telegram notification when source is not telegram and returns 200', async () => {
        const [stationId] = await pickStationIds(1)

        const response = await sendReportRequest({
            stationId: stationId!,
            source: 'web_app',
        })

        expect(response.status).toBe(200)
        expect(capturedRequests.length).toBe(1)
        expect(capturedRequests[0]?.password).toBe('test-password')

        const body = capturedRequests[0]?.body as {
            line: string | null
            station: string
            direction: string | null
            message: string | null
            stationId: string
        }

        expect(body.stationId).toBe(stationId!)
        expect(typeof body.station).toBe('string')
    })

    it('returns 200 and a failure header when Telegram notification fails', async () => {
        const [stationId] = await pickStationIds(1)

        shouldFail = true

        const response = await sendReportRequest({
            stationId: stationId!,
            source: 'web_app',
        })

        expect(response.status).toBe(200)
        expect(response.headers.get('X-Telegram-Notification-Status')).toBe('failed')

        // ensure we still attempted to call the NLP service
        expect(capturedRequests.length).toBe(1)
    })

    it('does not send a Telegram notification if the report is rejected', async () => {
        const response = await sendReportRequest({
            stationId: 'invalid_id', // No such station in the network
            source: 'web_app',
        })

        // Used to be a 500 from a foreign key violation. The station is now checked against the
        // network before the insert, which turns a user mistake into a 422 instead of a server error.
        expect(response.status).toBe(422)
        expect(capturedRequests.length).toBe(0)
    })
})

describe('Security Verification', () => {
    it('bypasses security check when the correct X-Password is provided', async () => {
        const [stationId] = await pickStationIds(1)
        securityValidResponse = false // Even if security would have blocked it

        const response = await sendReportRequest({
            stationId: stationId!,
        })

        // Should succeed because password bypasses security service call
        expect(response.status).toBe(200)
    })
})

describe('Report API contract', () => {
    beforeAll(async () => {
        await seedBaseData(db)

        process.env.NODE_ENV = 'production'
        process.env.REPORT_PASSWORD = 'test-password' // To pass the security check
    })

    it('rejects reports without station, line, and direction', async () => {
        const response = await sendReportRequest({
            source: 'web_app',
            // stationId, lineId and directionId are omitted on purpose
        })

        expect(response.status).toBe(400)

        const responseBody = await response.text()
        expect(responseBody).toContain('At least one of stationId, lineId, or directionId must be provided')
    })

    it('returns only the created report', async () => {
        const [stationId] = await pickStationIds(1)

        const response = await sendReportRequest({
            stationId: stationId!,
            source: 'web_app',
        })

        expect(response.status).toBe(200)

        const body = (await response.json()) as unknown

        expect(Array.isArray(body)).toBe(false)
        expect(typeof body).toBe('object')
        expect(body).not.toBeNull()

        const createdReport = body as {
            reportId: number
            stationId: string
            lineId: string | null
            directionId: string | null
            timestamp: string | Date
            source?: unknown
        }

        expect(typeof createdReport.reportId).toBe('number')
        expect(createdReport.stationId).toBe(stationId!)
        expect(createdReport).not.toHaveProperty('source')
        expect(createdReport.timestamp).toBeTruthy()
    })

    it('guesses the station when a line is provided without a station', async () => {
        // Ensure deterministic history for this test
        await db.delete(reports)

        const entry = { lineId: await pickLineId() }
        const stationsOnLine = (await pickStationIdsOnLine(entry.lineId, 3)).map((id) => ({ stationId: id }))

        const mostCommonStationId = stationsOnLine[0]!.stationId
        const lessCommonStationId = stationsOnLine[1]?.stationId ?? stationsOnLine[0]!.stationId

        await db.insert(reports).values([
            // Make one station clearly the most common for this line at the current time window
            {
                networkId: DEFAULT_NETWORK_ID,
                stationId: mostCommonStationId,
                lineId: entry.lineId,
                directionId: null,
                source: 'web_app',
            },
            {
                networkId: DEFAULT_NETWORK_ID,
                stationId: mostCommonStationId,
                lineId: entry.lineId,
                directionId: null,
                source: 'web_app',
            },
            {
                networkId: DEFAULT_NETWORK_ID,
                stationId: mostCommonStationId,
                lineId: entry.lineId,
                directionId: null,
                source: 'web_app',
            },
            {
                networkId: DEFAULT_NETWORK_ID,
                stationId: mostCommonStationId,
                lineId: entry.lineId,
                directionId: null,
                source: 'web_app',
            },
            {
                networkId: DEFAULT_NETWORK_ID,
                stationId: mostCommonStationId,
                lineId: entry.lineId,
                directionId: null,
                source: 'web_app',
            },
            {
                networkId: DEFAULT_NETWORK_ID,
                stationId: lessCommonStationId,
                lineId: entry.lineId,
                directionId: null,
                source: 'web_app',
            },
        ])

        const response = await sendReportRequest({
            lineId: entry.lineId,
            directionId: null,
            source: 'web_app',
            // stationId is omitted on purpose
        })

        expect(response.status).toBe(200)

        const body = (await response.json()) as {
            reportId: number
            stationId: string
            lineId: string | null
            directionId: string | null
            timestamp: string | Date
        }

        expect(typeof body.reportId).toBe('number')
        expect(body.lineId).toBe(entry.lineId)
        expect(body.stationId).toBe(mostCommonStationId)

        const stationIsOnLine = await db
            .select({ stationId: lineStations.stationId })
            .from(lineStations)
            .where(
                and(
                    eq(lineStations.networkId, DEFAULT_NETWORK_ID),
                    eq(lineStations.lineId, entry.lineId),
                    eq(lineStations.stationId, body.stationId)
                )
            )
            .limit(1)

        expect(stationIsOnLine.length).toBe(1)
    })

    it('breaks ties in station guessing by choosing the lexicographically smallest stationId', async () => {
        // Ensure deterministic history
        await db.delete(reports)

        const entry = { lineId: await pickLineId() }
        const stationsOnLine = (await pickStationIdsOnLine(entry.lineId, 2)).map((id) => ({ stationId: id }))

        if (stationsOnLine.length < 2) return

        const station1 = stationsOnLine[0]!.stationId
        const station2 = stationsOnLine[1]!.stationId

        const [sorted1] = [station1, station2].sort()

        // Insert equal number of reports for both stations to create a tie
        await db.insert(reports).values([
            {
                networkId: DEFAULT_NETWORK_ID,
                stationId: station1,
                lineId: entry.lineId,
                directionId: null,
                source: 'web_app',
            },
            {
                networkId: DEFAULT_NETWORK_ID,
                stationId: station2,
                lineId: entry.lineId,
                directionId: null,
                source: 'web_app',
            },
        ])

        const response = await sendReportRequest({
            lineId: entry.lineId,
            directionId: null,
            source: 'web_app',
            // stationId is omitted
        })

        expect(response.status).toBe(200)

        const body = (await response.json()) as { stationId: string }
        expect(body.stationId).toBe(sorted1)
    })

    it('defaults to telegram source when source is missing in request', async () => {
        const [stationId] = await pickStationIds(1)

        const response = await sendReportRequest({
            stationId: stationId!,
            // source is omitted
        })

        expect(response.status).toBe(200)

        const [report] = await db
            .select({ source: reports.source })
            .from(reports)
            .orderBy(desc(reports.timestamp))
            .limit(1)

        expect(report.source).toBe('telegram')
    })

    it('can submit a report with a direction', async () => {
        // Find a valid line and station connection
        const lineId = await pickLineId()
        const entry = { lineId, stationId: (await pickStationIdsOnLine(lineId, 1))[0]! }

        // Find the final station (direction) for this line
        const [finalStation] = await db
            .select({
                id: stations.id,
                name: stations.name,
            })
            .from(lineStations)
            .innerJoin(stations, eq(lineStations.stationId, stations.id))
            .where(and(eq(lineStations.networkId, DEFAULT_NETWORK_ID), eq(lineStations.lineId, entry.lineId)))
            .orderBy(desc(lineStations.order))
            .limit(1)

        const response = await sendReportRequest({
            stationId: entry.stationId,
            lineId: entry.lineId,
            directionId: finalStation.id,
            source: 'web_app',
        })

        expect(response.status).toBe(200)

        const [report] = await db
            .select({
                directionId: reports.directionId,
            })
            .from(reports)
            .orderBy(desc(reports.timestamp))
            .limit(1)

        expect(report.directionId).toBe(finalStation.id)
    })

    it('rejects reports with an invalid lineId instead of crashing', async () => {
        const response = await sendReportRequest({
            lineId: 'NON_EXISTENT_LINE',
            source: 'web_app',
        })

        expect(response.status).toBe(400)
    })

    it('rejects reports with an invalid stationId instead of crashing', async () => {
        const response = await sendReportRequest({
            stationId: 'NON_EXISTENT_STATION',
            source: 'web_app',
        })

        expect(response.status).toBe(400)
    })

    it('rejects reports with an invalid directionId instead of crashing', async () => {
        const response = await sendReportRequest({
            directionId: 'NON_EXISTENT_DIRECTION',
            source: 'web_app',
        })
        expect(response.status).toBe(400)
    })

    it('rejects reports with an invalid source instead of crashing', async () => {
        const response = await sendReportRequest({
            source: 'NON_EXISTENT_SOURCE',
        })
        expect(response.status).toBe(400)
    })
})

describe('Report Post Processing', () => {
    let stationsMap: Stations
    let linesMap: Record<string, string[]>

    let stationWithOneLineId: string
    let stationWithMultipleLinesId: string
    let directionWithOneLineId: string
    let lineIdForStationWithOneLine: string
    let lineIdForDirectionWithOneLine: string
    let stationNotOnLineId: string
    let stationOnSameLineAsStationWithOneLineId: string
    let stationWithMultipleLinesAndDirectionSharingSingleLine: string
    let directionWithMultipleLinesSharingSingleLine: string
    let sharedLineId: string
    let stationWithMultipleLinesAndDirectionSharingNoLines: string
    let directionWithMultipleLinesSharingNoLines: string
    let lineWithMiddleStationId: string
    let middleStationId: string
    let stationAfterMiddleId: string
    let firstStationOnLineId: string

    beforeAll(async () => {
        await seedBaseData(db)
        const transitService = new TransitNetworkDataService(db)
        stationsMap = await transitService.getStations(DEFAULT_NETWORK_ID)
        linesMap = Object.fromEntries(
            Object.entries(await transitService.getLines(DEFAULT_NETWORK_ID)).map(([key, value]) => [key, value ?? []])
        )

        const stationEntries = Object.entries(stationsMap)

        const stationWithOneLineEntry = stationEntries.find(([, s]) => s.lines.length === 1)
        if (!stationWithOneLineEntry) throw new Error('No station with 1 line found')
        stationWithOneLineId = stationWithOneLineEntry[0]
        lineIdForStationWithOneLine = stationWithOneLineEntry[1].lines[0]!

        /*
         * The direction used below has to serve exactly one line, so that a report naming only a
         * direction has one line to infer, and that line has to be one the multi line station also
         * serves, so that "take the line from the direction" has something to take. Picking the two
         * independently makes the tests pass or fail depending on which stations the seed happens to
         * return first.
         */
        const stationAndDirectionPair = stationEntries
            .filter(([, station]) => station.lines.length > 1)
            .flatMap(([multiLineId, multiLineStation]) =>
                stationEntries
                    .filter(
                        ([singleLineId, singleLineStation]) =>
                            singleLineStation.lines.length === 1 &&
                            singleLineId !== multiLineId &&
                            multiLineStation.lines.includes(singleLineStation.lines[0]!)
                    )
                    .map(([singleLineId, singleLineStation]) => ({
                        multiLineId,
                        singleLineId,
                        lineId: singleLineStation.lines[0]!,
                    }))
            )
            .at(0)

        if (!stationAndDirectionPair) {
            throw new Error('No multi line station found that shares its line with a single line station')
        }

        stationWithMultipleLinesId = stationAndDirectionPair.multiLineId
        directionWithOneLineId = stationAndDirectionPair.singleLineId
        lineIdForDirectionWithOneLine = stationAndDirectionPair.lineId

        const stationNotOnLineEntry = stationEntries.find(([, s]) => !s.lines.includes(lineIdForStationWithOneLine))
        if (!stationNotOnLineEntry) throw new Error('No station found that is not on the selected line')
        stationNotOnLineId = stationNotOnLineEntry[0]

        const stationOnSameLineEntry = stationEntries.find(
            ([id, s]) => s.lines.includes(lineIdForStationWithOneLine) && id !== stationWithOneLineId
        )
        if (!stationOnSameLineEntry) throw new Error('No second station on the same line found')
        stationOnSameLineAsStationWithOneLineId = stationOnSameLineEntry[0]

        const multiLineStations = stationEntries.filter(([, s]) => s.lines.length > 1)
        const sharedSingleLineMatch = multiLineStations
            .flatMap(([stationId, station]) =>
                multiLineStations
                    .filter(([directionId]) => directionId !== stationId)
                    .map(([directionId, direction]) => {
                        const directionLines = new Set(direction.lines)
                        const sharedLines = station.lines.filter((lineId) => directionLines.has(lineId))
                        return { stationId, directionId, sharedLines }
                    })
            )
            .find(({ sharedLines }) => sharedLines.length === 1)

        if (!sharedSingleLineMatch) {
            throw new Error('No stations found where station and direction share exactly one line')
        }

        stationWithMultipleLinesAndDirectionSharingSingleLine = sharedSingleLineMatch.stationId
        directionWithMultipleLinesSharingSingleLine = sharedSingleLineMatch.directionId
        sharedLineId = sharedSingleLineMatch.sharedLines[0]!

        const sharedNoLinesMatch = multiLineStations
            .flatMap(([stationId, station]) =>
                multiLineStations
                    .filter(([directionId]) => directionId !== stationId)
                    .map(([directionId, direction]) => {
                        const directionLines = new Set(direction.lines)
                        const sharedLines = station.lines.filter((lineId) => directionLines.has(lineId))
                        return { stationId, directionId, sharedLines }
                    })
            )
            .find(({ sharedLines }) => sharedLines.length === 0)

        if (!sharedNoLinesMatch) {
            throw new Error('No stations found where station and direction share zero lines')
        }

        stationWithMultipleLinesAndDirectionSharingNoLines = sharedNoLinesMatch.stationId
        directionWithMultipleLinesSharingNoLines = sharedNoLinesMatch.directionId

        const lineEntries = Object.entries(linesMap)
        const lineWithMiddleStation = lineEntries.find(([, stationIds]) => stationIds.length >= 3)
        if (!lineWithMiddleStation) throw new Error('No line found with at least 3 stations')

        lineWithMiddleStationId = lineWithMiddleStation[0]
        firstStationOnLineId = lineWithMiddleStation[1][0]!
        middleStationId = lineWithMiddleStation[1][1]!
        stationAfterMiddleId = lineWithMiddleStation[1][2]!
    })

    /*
     * A report that names only a direction has its station guessed from what was reported on that
     * line before, so these cases need history for the line they use. They used to get it by
     * accident, from reports that earlier tests in this file had left behind, which made them depend
     * on both the order of the tests and on which station the fixture lookup happened to return.
     */
    beforeEach(async () => {
        await db.delete(reports)

        /* Dated well into the past on purpose. `guessStation` widens its window to the whole week,
           so age does not affect the guess, but it keeps this history out of assertions that read
           back the most recent report. */
        const historicTimestamp = DateTime.utc().minus({ days: 3 }).toJSDate()

        await db.insert(reports).values(
            [
                { stationId: stationWithOneLineId, lineId: lineIdForStationWithOneLine },
                { stationId: directionWithOneLineId, lineId: lineIdForDirectionWithOneLine },
            ].map(({ stationId, lineId }) => ({
                networkId: DEFAULT_NETWORK_ID,
                stationId,
                lineId,
                directionId: null,
                timestamp: historicTimestamp,
                source: 'web_app' as const,
            }))
        )
    })

    it('rejects direction only payload when no line can be inferred', async () => {
        const response = await sendReportRequest({
            source: 'web_app',
            directionId: stationWithMultipleLinesId,
        })

        expect(response.status).toBe(422)
    })

    it('Accept a direction only payload when a line can be inferred', async () => {
        const response = await sendReportRequest({
            source: 'web_app',
            directionId: directionWithOneLineId,
        })

        expect(response.status).toBe(200)

        const [report] = await db
            .select({ lineId: reports.lineId, stationId: reports.stationId, directionId: reports.directionId })
            .from(reports)
            .orderBy(desc(reports.timestamp))
            .limit(1)

        // The inferred line is the direction's own, since that is the only one it can come from.
        expect(report.lineId).toBe(lineIdForDirectionWithOneLine)
        expect(report.directionId).toBe(directionWithOneLineId)
    })

    it('if no line is present it will use the stations line', async () => {
        const response = await sendReportRequest({
            stationId: stationWithOneLineId,
            lineId: null,
            directionId: null,
            source: 'web_app',
        })

        expect(response.status).toBe(200)

        const [report] = await db
            .select({ lineId: reports.lineId })
            .from(reports)
            .orderBy(desc(reports.timestamp))
            .limit(1)

        const expectedLineId = stationsMap[stationWithOneLineId].lines[0]
        expect(report.lineId).toBe(expectedLineId)
    })

    it('does not remove the direction when line is missing', async () => {
        const response = await sendReportRequest({
            stationId: stationWithOneLineId,
            lineId: null,
            directionId: stationOnSameLineAsStationWithOneLineId,
            source: 'web_app',
        })

        expect(response.status).toBe(200)

        const [report] = await db
            .select({ directionId: reports.directionId })
            .from(reports)
            .orderBy(desc(reports.timestamp))
            .limit(1)

        /* A mid route direction is normalised to the terminus it implies, so the assertion is that
           the direction survived on the same line, not that it came back unchanged. Asserting the
           exact id only held while the fixture happened to pick a terminus. */
        expect(report.directionId).not.toBeNull()
        expect(linesMap[lineIdForStationWithOneLine]).toContain(report.directionId!)
    })

    it('if no line present and station the station has more than one line it will use the line of the direction', async () => {
        const response = await sendReportRequest({
            stationId: stationWithMultipleLinesId,
            lineId: null,
            directionId: directionWithOneLineId,
            source: 'web_app',
        })

        expect(response.status).toBe(200)

        const [report] = await db
            .select({ lineId: reports.lineId })
            .from(reports)
            .orderBy(desc(reports.timestamp))
            .limit(1)

        const expectedLineId = stationsMap[directionWithOneLineId].lines[0]
        expect(report.lineId).toBe(expectedLineId)
    })

    it('removes direction when direction is not on the provided line', async () => {
        const response = await sendReportRequest({
            stationId: stationWithOneLineId,
            lineId: lineIdForStationWithOneLine,
            directionId: stationNotOnLineId,
            source: 'web_app',
        })

        expect(response.status).toBe(200)

        const [report] = await db
            .select({ directionId: reports.directionId, lineId: reports.lineId })
            .from(reports)
            .orderBy(desc(reports.timestamp))
            .limit(1)

        expect(report.lineId).toBe(lineIdForStationWithOneLine)
        expect(report.directionId).toBeNull()
    })

    it('clears station when station is not on the provided line', async () => {
        const response = await sendReportRequest({
            stationId: stationNotOnLineId,
            lineId: lineIdForStationWithOneLine,
            directionId: null,
            source: 'web_app',
        })

        expect(response.status).toBe(200)

        const [report] = await db
            .select({ stationId: reports.stationId })
            .from(reports)
            .orderBy(desc(reports.timestamp))
            .limit(1)

        expect(typeof report.stationId).toBe('string')
        expect(report.stationId.length).toBeGreaterThan(0)
    })

    it('If no line and station has more than one line it will continue with line as null', async () => {
        const response = await sendReportRequest({
            stationId: stationWithMultipleLinesId,
            lineId: null,
            directionId: null,
            source: 'web_app',
        })

        expect(response.status).toBe(200)

        const [report] = await db
            .select({ lineId: reports.lineId })
            .from(reports)
            .orderBy(desc(reports.timestamp))
            .limit(1)

        expect(report.lineId).toBeNull()
    })

    it('chooses the shared line when station and direction share a single line', async () => {
        const response = await sendReportRequest({
            stationId: stationWithMultipleLinesAndDirectionSharingSingleLine,
            lineId: null,
            directionId: directionWithMultipleLinesSharingSingleLine,
            source: 'web_app',
        })

        expect(response.status).toBe(200)

        const [report] = await db
            .select({ lineId: reports.lineId })
            .from(reports)
            .orderBy(desc(reports.timestamp))
            .limit(1)

        expect(report.lineId).toBe(sharedLineId)
    })

    it('clears direction when station and direction share no lines and no line is provided', async () => {
        const response = await sendReportRequest({
            stationId: stationWithMultipleLinesAndDirectionSharingNoLines,
            lineId: null,
            directionId: directionWithMultipleLinesSharingNoLines,
            source: 'web_app',
        })

        expect(response.status).toBe(200)

        const [report] = await db
            .select({ lineId: reports.lineId, directionId: reports.directionId })
            .from(reports)
            .orderBy(desc(reports.timestamp))
            .limit(1)

        expect(report.lineId).toBeNull()
        expect(report.directionId).toBeNull()
    })

    it('corrects direction to the terminal station when the direction is implied', async () => {
        const response = await sendReportRequest({
            stationId: stationAfterMiddleId,
            lineId: lineWithMiddleStationId,
            directionId: middleStationId, // not a terminal station
            source: 'web_app',
        })

        expect(response.status).toBe(200)

        const [report] = await db
            .select({ directionId: reports.directionId })
            .from(reports)
            .orderBy(desc(reports.timestamp))
            .limit(1)

        expect(report.directionId).toBe(firstStationOnLineId)
    })

    it('corrects direction to the last terminal station when the station is before the direction', async () => {
        const stationsOnLine = linesMap[lineWithMiddleStationId]
        const lastStationOnLineId = stationsOnLine[stationsOnLine.length - 1]

        const response = await sendReportRequest({
            stationId: firstStationOnLineId,
            lineId: lineWithMiddleStationId,
            directionId: middleStationId,
            source: 'web_app',
        })

        expect(response.status).toBe(200)

        const [report] = await db
            .select({ directionId: reports.directionId })
            .from(reports)
            .orderBy(desc(reports.timestamp))
            .limit(1)

        expect(report.directionId).toBe(lastStationOnLineId)
    })

    it('does not change direction if it is already a terminal station', async () => {
        const stationsOnLine = linesMap[lineWithMiddleStationId]
        const lastStationOnLineId = stationsOnLine[stationsOnLine.length - 1]

        const response = await sendReportRequest({
            stationId: middleStationId,
            lineId: lineWithMiddleStationId,
            directionId: lastStationOnLineId,
            source: 'web_app',
        })

        expect(response.status).toBe(200)

        const [report] = await db
            .select({ directionId: reports.directionId })
            .from(reports)
            .orderBy(desc(reports.timestamp))
            .limit(1)

        expect(report.directionId).toBe(lastStationOnLineId)
    })

    it('clears direction when station and direction are the same', async () => {
        const response = await sendReportRequest({
            stationId: stationWithOneLineId,
            lineId: lineIdForStationWithOneLine,
            directionId: stationWithOneLineId,
            source: 'web_app',
        })

        expect(response.status).toBe(200)

        const [report] = await db
            .select({ directionId: reports.directionId })
            .from(reports)
            .orderBy(desc(reports.timestamp))
            .limit(1)

        expect(report.directionId).toBeNull()
    })

    it('clears direction when direction is present without a line', async () => {
        const response = await sendReportRequest({
            stationId: stationWithOneLineId,
            lineId: null,
            directionId: stationWithOneLineId,
            source: 'web_app',
        })
        expect(response.status).toBe(200)

        const [report] = await db
            .select({ directionId: reports.directionId })
            .from(reports)
            .orderBy(desc(reports.timestamp))
            .limit(1)

        expect(report.directionId).toBeNull()
    })

    it('clears direction when station is on one line and direction is on another and no lineId is provided', async () => {
        const response = await sendReportRequest({
            stationId: stationWithOneLineId,
            lineId: null,
            directionId: stationNotOnLineId,
            source: 'web_app',
        })

        expect(response.status).toBe(200)

        const [report] = await db
            .select({ lineId: reports.lineId, directionId: reports.directionId })
            .from(reports)
            .orderBy(desc(reports.timestamp))
            .limit(1)

        expect(report.lineId).toBe(lineIdForStationWithOneLine)
        expect(report.directionId).toBeNull()
    })
})
