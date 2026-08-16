import { and, asc, eq } from 'drizzle-orm'

import { DbConnection, stations, lineStations, lines } from '../../db'
import type { NetworkId } from '../networks/types'

import type { Lines, LinesMetadata, Stations } from './types'

/**
 * Serves the station and line graph of a single network.
 *
 * Everything here is keyed by network. That is not just an optimisation: the returned records are
 * what the report inference rules reason over, so handing them data from more than one network is
 * what would let a Hamburg report be resolved against a Berlin station.
 *
 * Network data only changes when a seed runs, so each network's result is cached for the lifetime
 * of the process. The cache is a map rather than a single slot, because a deployment serves as
 * many networks as it has cities.
 */
export class TransitNetworkDataService {
    private stationsCache = new Map<NetworkId, Promise<Stations>>()
    private linesCache = new Map<NetworkId, Promise<Lines>>()
    private lineMetadataCache = new Map<NetworkId, Promise<LinesMetadata>>()

    constructor(private db: DbConnection) {}

    /**
     * Colour, mode and circularity of every line, which is what a client needs to draw one.
     *
     * Kept apart from `getLines` so that the station order, which is far larger, is not refetched
     * every time a client only wants to know how to render a line.
     */
    async getLineMetadata(networkId: NetworkId): Promise<LinesMetadata> {
        const cached = this.lineMetadataCache.get(networkId)
        if (cached) {
            return cached
        }

        const metadataPromise = (async () => {
            try {
                const rows = await this.db
                    .select({
                        id: lines.id,
                        color: lines.color,
                        mode: lines.mode,
                        isCircular: lines.isCircular,
                    })
                    .from(lines)
                    .where(eq(lines.networkId, networkId))
                    .orderBy(asc(lines.id))

                return Object.fromEntries(rows.map(({ id, ...metadata }) => [id, metadata])) as LinesMetadata
            } catch (error) {
                this.lineMetadataCache.delete(networkId)
                throw error
            }
        })()

        this.lineMetadataCache.set(networkId, metadataPromise)
        return metadataPromise
    }

    async getStations(networkId: NetworkId): Promise<Stations> {
        const cached = this.stationsCache.get(networkId)
        if (cached) {
            return cached
        }

        const stationsPromise = (async () => {
            try {
                const joinedRows = await this.db
                    .select({
                        id: stations.id,
                        name: stations.name,
                        lat: stations.lat,
                        lng: stations.lng,
                        lineId: lineStations.lineId,
                    })
                    .from(stations)
                    /* Both key columns are required here. Station ids are globally unique, so
                       joining on `stationId` alone happens to work today, but carrying the network
                       keeps the query on the network index and makes the intent explicit. */
                    .leftJoin(
                        lineStations,
                        and(eq(lineStations.networkId, stations.networkId), eq(lineStations.stationId, stations.id))
                    )
                    .where(eq(stations.networkId, networkId))
                    /* Without an explicit order Postgres is free to return rows in whatever order
                       the heap happens to have them, which changes after an update. The response is
                       revalidated by ETag (see the transit middleware in `index.ts`), and that ETag
                       is a hash of the body, so a stable key order keeps a re-seed that changed
                       nothing from invalidating every client's copy. */
                    .orderBy(asc(stations.id), asc(lineStations.order))

                return joinedRows.reduce<Stations>((stationsById, row) => {
                    const base = Object.prototype.hasOwnProperty.call(stationsById, row.id)
                        ? stationsById[row.id]
                        : {
                              name: row.name,
                              coordinates: { latitude: row.lat, longitude: row.lng },
                              lines: [],
                          }
                    const lines = row.lineId !== null ? [...base.lines, row.lineId] : base.lines
                    stationsById[row.id] = { ...base, lines }
                    return stationsById
                }, {} as Stations)
            } catch (error) {
                this.stationsCache.delete(networkId)
                throw error
            }
        })()

        this.stationsCache.set(networkId, stationsPromise)
        return stationsPromise
    }

    async getLines(networkId: NetworkId): Promise<Lines> {
        const cached = this.linesCache.get(networkId)
        if (cached) {
            return cached
        }

        const linesPromise = (async () => {
            try {
                const joinedRows = await this.db
                    .select({
                        lineId: lines.id,
                        stationId: lineStations.stationId,
                    })
                    .from(lines)
                    /* Both key columns are required here: joining on `lineId` alone would pair
                       Berlin's S1 with every other network's S1. */
                    .leftJoin(
                        lineStations,
                        and(eq(lineStations.networkId, lines.networkId), eq(lineStations.lineId, lines.id))
                    )
                    .where(eq(lines.networkId, networkId))
                    .orderBy(asc(lines.id), asc(lineStations.order))

                return joinedRows.reduce<Lines>((linesById, row) => {
                    const base = Object.prototype.hasOwnProperty.call(linesById, row.lineId)
                        ? linesById[row.lineId]
                        : []
                    const stations = row.stationId !== null ? [...base, row.stationId] : base
                    linesById[row.lineId] = stations
                    return linesById
                }, {} as Lines)
            } catch (error) {
                this.linesCache.delete(networkId)
                throw error
            }
        })()

        this.linesCache.set(networkId, linesPromise)
        return linesPromise
    }
}
