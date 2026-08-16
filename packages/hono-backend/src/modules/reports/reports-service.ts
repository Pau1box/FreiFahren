import { and, desc, eq, gte, lte } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { z } from 'zod'

import { AppError } from '../../common/errors'
import { lookupStation } from '../../common/utils'
import { DbConnection, InsertReport, reports } from '../../db/'
import type { Network, NetworkId } from '../networks/types'
import type { TransitNetworkDataService } from '../transit/transit-network-data-service'
import type { Lines, StationId, Stations } from '../transit/types'

import {
    assignLineIfSingleOption,
    clearStationReferenceIfNotOnLine,
    correctDirectionIfImplied,
    determineLineBasedOnStationAndDirection,
    guessStation,
    pipeAsync,
    RawReport,
    clearDirectionIfStationAndDirectionAreTheSame,
    ifDirectionPresentWithoutLineClearDirection,
} from './post-process-report'

const MIN_PREDICTED_REPORTS_THRESHOLD = 1
const MAX_PREDICTED_REPORTS_THRESHOLD = 7

type LuxonWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7

const isWeekend = (weekday: LuxonWeekday): boolean => weekday === 6 || weekday === 7

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

// Shared by the read and the write path so that both answer a cross network id the same way.
const NETWORK_SCOPE_HINT =
    'Every station, direction and line has to belong to the reported network. ' +
    'Check the `network` query parameter against GET /v0/networks.'

/**
 * Reads an instant as a wall clock time in the network's city.
 *
 * Everything downstream reasons about the time of day (the threshold curve models a day in the
 * city, and `guessStation` buckets history by hour), so the server's own timezone must never enter
 * the calculation. `networks.timezone` exists for exactly this.
 *
 * A malformed zone would turn the DateTime invalid and poison every hour downstream with NaN, so we
 * fall back to UTC rather than failing the request: showing the curve an hour off is a smaller
 * failure than serving no reports at all.
 */
const inNetworkTime = (instant: DateTime, network: Network): DateTime => {
    const localTime = instant.setZone(network.timezone)

    return localTime.isValid ? localTime : instant.toUTC()
}

const calculateBasePredictedReportsThreshold = (currentTime: DateTime): number => {
    const minutesPastMidnight = currentTime.hour * 60 + currentTime.minute

    const isSaturday = currentTime.weekday === 6

    if (minutesPastMidnight >= 18 * 60 && isSaturday && minutesPastMidnight < 24 * 60) {
        // On Saturdays, decrease linearly from 18:00 to 24:00
        return 7 - (minutesPastMidnight - 18 * 60) * (6.0 / (6 * 60))
    }

    if (minutesPastMidnight >= 18 * 60 && minutesPastMidnight < 21 * 60) {
        // On other days, decrease linearly from 18:00 to 21:00
        return 7 - (minutesPastMidnight - 18 * 60) * (6.0 / (3 * 60))
    }

    if (minutesPastMidnight >= 21 * 60 || minutesPastMidnight < 7 * 60) {
        // Stay at 1 between 21:00 to 7:00
        return 1
    }

    if (minutesPastMidnight >= 7 * 60 && minutesPastMidnight < 9 * 60) {
        // Increase linearly from 7:00 to 9:00
        return 1 + (minutesPastMidnight - 7 * 60) * (6.0 / (2 * 60))
    }

    return 7
}

const calculateWeekendAdjustment = (currentTime: DateTime, baseThreshold: number): number => {
    if (!isWeekend(currentTime.weekday as LuxonWeekday)) return 0

    const truncatedBase = Math.trunc(baseThreshold)
    return truncatedBase * 0.5
}

type TelegramNotificationPayload = {
    line: string | null
    station: string
    direction: StationId | null
    message: string | null
    stationId: StationId
    // Picks the Telegram group on the bot's side. Without it every report is announced in the
    // group of the bot's default network, so a Hamburg report would land in the Berlin group.
    network: NetworkId
}

type ReportSummary = Pick<typeof reports.$inferSelect, 'timestamp' | 'stationId' | 'directionId' | 'lineId'> & {
    isPredicted: boolean
}

export class ReportsService {
    constructor(
        private db: DbConnection,
        private transitNetworkDataService: TransitNetworkDataService
    ) {}

    /**
     * Rejects a station id the requested network does not contain, before any report is read for it.
     *
     * The read path used to filter in SQL alone, so a station of another network simply matched
     * nothing and the client got `200 []`. That is indistinguishable from "no inspectors reported
     * here" and hides exactly the mistake it should surface, a client asking with the wrong network
     * selected. The write path already answers such a request with a 422 that names the field, so
     * the read path uses the same shape.
     */
    async assertStationExistsInNetwork(stationId: StationId, networkId: NetworkId): Promise<void> {
        const stations = await this.transitNetworkDataService.getStations(networkId)

        if (Object.prototype.hasOwnProperty.call(stations, stationId)) return

        throw new AppError({
            message: `Unknown stationId for network '${networkId}'`,
            statusCode: 422,
            internalCode: 'VALIDATION_FAILED',
            description: NETWORK_SCOPE_HINT,
        })
    }

    async verifyRequest(headers: Record<string, string>): Promise<void> {
        const reportPassword = process.env.REPORT_PASSWORD
        const isDev = process.env.NODE_ENV === 'development'

        // Exceptions for dev mode and the Telegram Bot (Identified by the X-Password header)
        if (
            (reportPassword !== undefined && reportPassword !== '' && headers['x-password'] === reportPassword) ||
            isDev
        ) {
            return
        }

        const securityServiceUrl = process.env.SECURITY_MICROSERVICE_URL
        if (securityServiceUrl === undefined || securityServiceUrl === '') {
            throw new Error('security service configuration error')
        }

        const response = await fetch(`${securityServiceUrl.replace(/\/$/, '')}/check`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ headers }),
        })

        if (!response.ok) {
            throw new Error(`failed to verify request with status ${response.status}: ${await response.text()}`)
        }

        const result = (await response.json()) as { valid: boolean }

        if (!result.valid) {
            throw new AppError({
                message:
                    'Spam reports are not allowed, if you have an issue with us contact us and we can hash it out.',
                statusCode: 403,
                internalCode: 'SPAM_REPORT_DETECTED',
            })
        }
    }

    async getReports({
        network,
        from,
        to,
        stationId,
        currentTime,
    }: {
        network: Network
        from: DateTime
        to: DateTime
        stationId?: StationId
        currentTime: DateTime
    }): Promise<ReportSummary[]> {
        const dbResults = await this.db
            .select({
                timestamp: reports.timestamp,
                stationId: reports.stationId,
                directionId: reports.directionId,
                lineId: reports.lineId,
            })
            .from(reports)
            .where(
                and(
                    eq(reports.networkId, network.id),
                    gte(reports.timestamp, from.toJSDate()),
                    lte(reports.timestamp, to.toJSDate()),
                    stationId !== undefined ? eq(reports.stationId, stationId) : undefined
                )
            )

        const result: ReportSummary[] = dbResults.map((r) => ({ ...r, isPredicted: false }))

        if (!this.mayPredictFor(network)) return result

        /* Predict reports if we don't have enough, so that users always see at least some data.

           The threshold curve models a day in the city (ramp up from 07:00, decline from 18:00), so
           it is read off the network's local clock rather than the server's. */
        const predictedReportsThreshold = this.calculatePredictedReportsThreshold(inNetworkTime(currentTime, network))
        if (result.length < predictedReportsThreshold) {
            const numberOfReportsToFetch = predictedReportsThreshold - result.length
            const reportedStationIds = new Set(result.map((r) => r.stationId as StationId))
            const allowedStationIds = await this.resolveAllowedStationIds(network.id, stationId, reportedStationIds)
            const historicReports = await this.predictReports(
                network,
                numberOfReportsToFetch,
                from,
                to,
                allowedStationIds
            )
            result.push(...historicReports)
        }

        return result
    }

    /**
     * Whether a network may show predicted reports at all.
     *
     * Predictions exist so that an established network never shows an empty map, on the assumption
     * that history says something about the present. A network that has just been added has no such
     * history, so predicting from it would not fill a gap, it would invent inspectors that were
     * never reported. A newcomer opening the app in a new city is exactly the person who must not be
     * misled.
     *
     * We key this off the network's declared status rather than a row count, because "is there
     * enough coverage here to reason from" is an operational judgement, not something a magic
     * number in the code should decide. A network is added as `beta`, shows only real reports, and
     * is promoted to `active` once its coverage is real.
     */
    private mayPredictFor(network: Network): boolean {
        return network.status === 'active'
    }

    /* Determines which stations the prediction algorithm may emit reports for.
       Candidates never leave the requested network, otherwise a city with little traffic would be
       filled up with invented reports from a busier one.
       When the query is scoped to a specific station, predictions are restricted to that station.
       When the query is unscoped, any station of the network that hasn't already reported is a
       candidate. */
    private async resolveAllowedStationIds(
        networkId: NetworkId,
        stationId: StationId | undefined,
        reportedStationIds: ReadonlySet<StationId>
    ): Promise<ReadonlySet<StationId>> {
        const networkStations = await this.transitNetworkDataService.getStations(networkId)

        if (stationId !== undefined) {
            const isInNetwork = Object.prototype.hasOwnProperty.call(networkStations, stationId)
            if (!isInNetwork || reportedStationIds.has(stationId)) return new Set()

            return new Set([stationId])
        }

        return new Set((Object.keys(networkStations) as StationId[]).filter((id) => !reportedStationIds.has(id)))
    }

    // Returns the integer threshold that controls how many predicted/historic reports we should show.
    private calculatePredictedReportsThreshold(currentTime: DateTime): number {
        const base = calculateBasePredictedReportsThreshold(currentTime)
        const adjustment = calculateWeekendAdjustment(currentTime, base)
        const threshold = base - adjustment

        return Math.trunc(clamp(threshold, MIN_PREDICTED_REPORTS_THRESHOLD, MAX_PREDICTED_REPORTS_THRESHOLD))
    }

    private async predictReports(
        network: Network,
        numberOfReportsToFetch: number,
        from: DateTime,
        to: DateTime,
        allowedStationIds: ReadonlySet<StationId>
    ): Promise<ReportSummary[]> {
        if (numberOfReportsToFetch <= 0) return []
        if (allowedStationIds.size === 0) return []

        // We only want predicted timestamps to appear old, so we constrain them to the first quarter of the requested range.
        // We limit to the first quarter to make it obvious to users that this data is historic/less reliable.
        const fromMillis = from.toMillis()
        const toMillis = to.toMillis()
        const rangeMillis = Math.max(0, toMillis - fromMillis)
        const toRandomDate = (millis: number): Date => new Date(Math.floor(millis))

        const randomTimestampInWindow = (windowStartMillis: number, windowEndMillis: number): Date => {
            const clampedStartMillis = Math.max(fromMillis, Math.min(windowStartMillis, toMillis))
            const clampedEndMillis = Math.max(fromMillis, Math.min(windowEndMillis, toMillis))
            const windowRange = clampedEndMillis - clampedStartMillis
            const millis = clampedStartMillis + Math.random() * windowRange
            return toRandomDate(millis)
        }

        const firstQuarterEndMillis = fromMillis + Math.floor(rangeMillis / 4)
        const firstHalfEndMillis = fromMillis + Math.floor(rangeMillis / 2)

        const candidateRows = await this.db
            .select({ stationId: reports.stationId, timestamp: reports.timestamp })
            .from(reports)
            .where(eq(reports.networkId, network.id))
            .orderBy(desc(reports.timestamp))
            .limit(1000)

        const usedStationIds = new Set<StationId>()
        const maxUniqueCount = Math.min(numberOfReportsToFetch, allowedStationIds.size)

        const results: ReportSummary[] = []

        // We only use `guessStation`. If we get a disallowed/duplicate/undefined guess, we broaden the timestamp window
        // (first quarter -> first half -> full range) and retry.
        const windows = [
            { start: fromMillis, end: firstQuarterEndMillis },
            { start: fromMillis, end: firstHalfEndMillis },
            { start: fromMillis, end: toMillis },
        ]

        const triesPerWindow = 25

        for (const window of windows) {
            for (let attempts = 0; attempts < triesPerWindow && results.length < maxUniqueCount; attempts++) {
                const timestamp = randomTimestampInWindow(window.start, window.end)
                const guessTime = inNetworkTime(DateTime.fromJSDate(timestamp), network)

                const guessInput: { stationId?: StationId } = {}
                const guessed = guessStation(candidateRows, guessTime.zone.name)(guessTime.hour, guessTime.weekday)(
                    guessInput
                )

                const stationId = guessed.stationId
                if (stationId === undefined) continue
                if (!allowedStationIds.has(stationId)) continue
                if (usedStationIds.has(stationId)) continue

                usedStationIds.add(stationId)
                results.push({ timestamp, stationId, directionId: null, lineId: null, isPredicted: true })
            }
        }

        // Prediction is inherently best-effort: if we cannot infer enough unique stations from history,
        // We return the subset we managed to infer instead of failing the whole request.
        return results
    }

    async createReport(reportData: InsertReport): Promise<{
        telegramNotificationSuccess: boolean
        report: {
            reportId: number
            stationId: string
            lineId: string | null
            directionId: string | null
            timestamp: Date
        }
    }> {
        const [insertedReport] = await this.db.insert(reports).values(reportData).returning({
            reportId: reports.reportId,
            stationId: reports.stationId,
            lineId: reports.lineId,
            directionId: reports.directionId,
            timestamp: reports.timestamp,
        })
        // Drizzle returns the inserted row for Postgres. If this ever becomes undefined, we want to surface it fast.
        const report = insertedReport!

        let telegramNotificationSuccess = true

        if (reportData.source !== 'telegram' && process.env.NODE_ENV === 'production') {
            try {
                await this.notifyTelegram(reportData)
            } catch {
                telegramNotificationSuccess = false
            }
        }

        return { telegramNotificationSuccess, report }
    }

    private async notifyTelegram(reportData: InsertReport) {
        const nlpServiceUrl = z.string().min(1).parse(process.env.NLP_SERVICE_URL)
        const reportPassword = z.string().min(1).parse(process.env.REPORT_PASSWORD)

        const endpoint = `${nlpServiceUrl.replace(/\/$/, '')}/report-inspector`
        const payload = await this.buildTelegramNotificationPayload(reportData)

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Password': reportPassword,
            },
            body: JSON.stringify(payload),
        })

        if (!response.ok) {
            const errorDetail = await response.text().catch(() => 'No response body')
            throw new Error(`Telegram bot notification failed with status ${response.status}: ${errorDetail}`)
        }
    }

    // This is so stupid... we should really rewrite the Bot so that the endpoint is more sensible
    private async buildTelegramNotificationPayload(reportData: InsertReport): Promise<TelegramNotificationPayload> {
        const stations = await this.transitNetworkDataService.getStations(reportData.networkId)

        const station = lookupStation(stations, reportData.stationId)
        const direction = lookupStation(stations, reportData.directionId)

        return {
            line: reportData.lineId ?? null,
            station: station?.name ?? reportData.stationId,
            direction: direction?.name ?? reportData.directionId ?? null,
            message: null,
            stationId: reportData.stationId,
            network: reportData.networkId,
        }
    }

    /**
     * Rejects a report that names something the requested network does not contain.
     *
     * Before multi network support an unknown id fell through to the insert and surfaced as a 500
     * from a foreign key violation. That is now the common case rather than a typo: a client with
     * the wrong network selected sends perfectly real ids that simply belong elsewhere. Answering
     * with a 422 that names the offending fields lets the client correct its network instead of
     * treating a user mistake as a server fault.
     */
    private assertReferencesExistInNetwork(reportData: RawReport, stations: Stations, lines: Lines): void {
        const has = (record: object, key: string | null | undefined): boolean =>
            key !== null && key !== undefined && Object.prototype.hasOwnProperty.call(record, key)

        const unknownFields = [
            reportData.stationId !== undefined && !has(stations, reportData.stationId) ? 'stationId' : null,
            reportData.directionId !== null &&
            reportData.directionId !== undefined &&
            !has(stations, reportData.directionId)
                ? 'directionId'
                : null,
            reportData.lineId !== null && reportData.lineId !== undefined && !has(lines, reportData.lineId)
                ? 'lineId'
                : null,
        ].filter((field) => field !== null)

        if (unknownFields.length === 0) return

        throw new AppError({
            message: `Unknown ${unknownFields.join(', ')} for network '${reportData.networkId}'`,
            statusCode: 422,
            internalCode: 'VALIDATION_FAILED',
            description: NETWORK_SCOPE_HINT,
        })
    }

    /* The network is passed alongside the report rather than looked up from `reportData.networkId`,
       because the caller has already resolved and validated it. It carries the timezone the station
       guess needs. */
    async postProcessReport(reportData: RawReport, network: Network): Promise<InsertReport> {
        const stations = await this.transitNetworkDataService.getStations(reportData.networkId)
        const lines = await this.transitNetworkDataService.getLines(reportData.networkId)

        this.assertReferencesExistInNetwork(reportData, stations, lines)

        // Guessing from history compares times of day, so it runs on the network's clock.
        const now = inNetworkTime(DateTime.utc(), network)

        const processed = await pipeAsync(
            reportData,
            clearStationReferenceIfNotOnLine(stations, 'stationId'),
            clearStationReferenceIfNotOnLine(stations, 'directionId'),
            assignLineIfSingleOption(stations),
            determineLineBasedOnStationAndDirection(stations),
            correctDirectionIfImplied(lines),
            clearDirectionIfStationAndDirectionAreTheSame,
            ifDirectionPresentWithoutLineClearDirection,
            async (currentReport) => {
                // Avoid guessing the station if we don't have a line
                // Otherwise the guess would be too broad and we would end up with a lot of false positives
                if (
                    currentReport.stationId !== undefined ||
                    currentReport.lineId === null ||
                    currentReport.lineId === undefined
                ) {
                    return currentReport
                }

                const candidateRows = await this.db
                    .select({ stationId: reports.stationId, timestamp: reports.timestamp })
                    .from(reports)
                    /* Scoping by network matters as much as scoping by line: without it, a report
                       on Hamburg's S1 would be guessed onto whichever Berlin station is busiest. */
                    .where(and(eq(reports.networkId, reportData.networkId), eq(reports.lineId, currentReport.lineId)))
                    .orderBy(desc(reports.timestamp))
                    .limit(1000)

                return guessStation(candidateRows, now.zone.name)(now.hour, now.weekday)(currentReport)
            },
            clearStationReferenceIfNotOnLine(stations, 'stationId'),
            clearStationReferenceIfNotOnLine(stations, 'directionId')
        )

        if (processed.stationId === undefined) {
            throw new AppError({
                message: 'Could not infer station from the provided information',
                statusCode: 422,
                internalCode: 'VALIDATION_FAILED',
                description: 'Provide a stationId, or a lineId the station can be inferred from.',
                /* The payload and the pipeline's output are what we need to debug a failed
                   inference, but they are ours, not the caller's. They go to the log only. */
                internalDetails: { input: reportData, processed },
            })
        }

        return { ...processed, stationId: processed.stationId }
    }
}
