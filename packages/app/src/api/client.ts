import axios from 'axios'
import { DateTime } from 'luxon'
import { Platform } from 'react-native'
import DeviceInfo from 'react-native-device-info'
import { z } from 'zod'

import { config } from '../config'
import { createETagMiddleware } from './etagMiddleware'

export const client = axios.create({
    baseURL: config.FF_API_BASE_URL,
    validateStatus: () => true,
    headers: {
        'ff-app-version': DeviceInfo.getVersion(),
        'ff-platform': Platform.OS,
    },
})

const etagMiddleware = createETagMiddleware({
    endpoints: ['/v0/lines', '/v0/stations', '/v0/lines/segments'],
})

etagMiddleware.applyMiddleware(client)

export const clearApiCache = etagMiddleware.clearAllCaches
export const clearEndpointCache = etagMiddleware.clearCache

export const reportSchema = z
    .object({
        timestamp: z.string().transform((value) => new Date(value)),
        line: z.string().transform((value: string) => (value === '' ? null : value)),
        isHistoric: z.boolean().default(false),
        direction: z
            .object({
                id: z.string(),
                name: z.string(),
            })
            .transform((value) => (value.name === '' || value.id === '' ? null : value)),
        station: z.object({
            id: z.string(),
        }),
    })
    .transform(({ station, ...rest }) => ({
        ...rest,
        stationId: station.id,
    }))

export type Report = z.infer<typeof reportSchema>
const getReports = async (network: string, start: DateTime, end: DateTime): Promise<Report[]> => {
    const { data } = await client.get('/v0/basics/inspectors', {
        params: {
            network,
            start: start.toISO(),
            end: end.toISO(),
        },
    })

    return reportSchema.array().parse(data)
}

const getRecentReports = async (network: string): Promise<Report[]> => {
    const now = DateTime.utc()
    const oneHourAgo = now.minus({ hours: 1 })

    return getReports(network, oneHourAgo, now)
}

type PostReport = {
    line: string
    stationId: string
    directionId: string | null
    message?: string
}

const postReport = async (network: string, report: PostReport) => {
    const { data } = await client.post(
        '/v0/basics/inspectors',
        {
            ...report,
            directionId: report.directionId ?? '',
        },
        { params: { network } }
    )

    return reportSchema.parse(data)
}

const riskSchema = z
    .object({
        segments_risk: z.record(z.object({ color: z.string(), risk: z.number() })),
    })
    .transform(({ segments_risk }) => ({
        segmentColors: Object.fromEntries(Object.entries(segments_risk).map(([sid, { color }]) => [sid, color])),
    }))

export type RiskData = z.infer<typeof riskSchema>

export const getRiskData = async (network: string): Promise<RiskData> => {
    const { data } = await client.get('/v1/risk-prediction/segment-colors', { params: { network } })

    return riskSchema.parse(data)
}

const coordinatesSchema = z.object({
    latitude: z.number(),
    longitude: z.number(),
})

export type Coordinates = z.infer<typeof coordinatesSchema>

export const networkSchema = z.object({
    id: z.string(),
    name: z.string(),
    countryCode: z.string(),
    timezone: z.string(),
    center: coordinatesSchema,
    bounds: z.object({
        southWest: coordinatesSchema,
        northEast: coordinatesSchema,
    }),
    status: z.enum(['active', 'beta']),
    /* The other cities this network reaches, for example Dortmund and Essen for the Rhine-Ruhr
       network that is filed under Düsseldorf. Defaulted rather than required so an older
       deployment, which does not send it, still parses. */
    serves: z.array(z.string()).default([]),
})

export type Network = z.infer<typeof networkSchema>

export const getNetworks = async (): Promise<Network[]> => {
    const { data } = await client.get('/v0/networks')

    return networkSchema.array().parse(data)
}

export const lineMetadataSchema = z.object({
    color: z.string(),
    /** A mode this client does not know is not worth losing every line colour over. */
    mode: z.enum(['subway', 'light_rail', 'tram', 'train', 'unknown']).catch('unknown'),
    /** Always present per the contract. Defaulted so an older deployment does not fail the parse. */
    isCircular: z.boolean().default(false),
})

export type LineMode = z.infer<typeof lineMetadataSchema>['mode']

export const linesMetadataSchema = z.record(lineMetadataSchema)
export type LinesMetadata = z.infer<typeof linesMetadataSchema>

export const getLinesMetadata = async (network: string): Promise<LinesMetadata> => {
    const { data } = await client.get('/v0/lines/metadata', { params: { network } })

    return linesMetadataSchema.parse(data)
}

export const stationSchema = z.object({
    name: z.string(),
    coordinates: coordinatesSchema,
    lines: z.array(z.string()),
})

export type Station = z.infer<typeof stationSchema>

export const stationsSchema = z.record(stationSchema.optional())
export type Stations = z.infer<typeof stationsSchema>

export const getStations = async (network: string): Promise<Stations> => {
    const { data } = await client.get('/v0/stations', { params: { network } })

    return stationsSchema.parse(data)
}

export const linesSchema = z.record(z.array(z.string()))
export type Lines = z.infer<typeof linesSchema>

export const getLines = async (network: string): Promise<Record<string, string[]>> => {
    const { data } = await client.get('/v0/lines', { params: { network } })

    return linesSchema.parse(data)
}

export const featureCollectionSchema = z.object({
    type: z.literal('FeatureCollection'),
    features: z.array(
        z.object({
            type: z.literal('Feature'),
            properties: z.object({
                sid: z.string(),
                line: z.string().optional(),
                line_color: z.string(),
            }),
            geometry: z.object({
                type: z.literal('LineString'),
                coordinates: z.array(z.array(z.number())),
            }),
        })
    ),
})

export type FeatureCollection = z.infer<typeof featureCollectionSchema>

export const getSegments = async (network: string): Promise<FeatureCollection> => {
    const { data } = await client.get('/v0/lines/segments', { params: { network } })

    return featureCollectionSchema.parse(data)
}

export const stationStatisticsSchema = z.object({
    numberOfReports: z.number(),
})

export type StationStatistics = z.infer<typeof stationStatisticsSchema>

export const getStationStatistics = async (network: string, stationId: string) => {
    // Station ids carry spaces, semicolons and umlauts, none of which survive a raw path segment.
    const { data } = await client.get(`/v0/stations/${encodeURIComponent(stationId)}/statistics`, {
        params: { network },
    })

    return stationStatisticsSchema.parse(data)
}

export const nodeSchema = z.object({
    name: z.string(),
    stopId: z.string(),
    lat: z.number(),
    lon: z.number(),
    departure: z.string().optional(),
    scheduledDeparture: z.string().optional(),
    arrival: z.string().optional(),
    scheduledArrival: z.string().optional(),
})

export const legSchema = z.object({
    mode: z.enum(['WALK', 'BUS', 'TRAM', 'METRO', 'SUBWAY', 'REGIONAL_RAIL']),
    from: nodeSchema,
    to: nodeSchema,
    duration: z.number(),
    startTime: z.string(),
    endTime: z.string(),
    scheduledStartTime: z.string(),
    scheduledEndTime: z.string(),
    realTime: z.boolean().optional(),
    routeShortName: z.string().optional(),
    intermediateStops: z.array(nodeSchema).optional(),
    legGeometry: z.object({
        points: z.string(),
        length: z.number(),
    }),
})

export const itinerarySchema = z.object({
    duration: z.number(),
    startTime: z.string(),
    endTime: z.string(),
    transfers: z.number(),
    legs: z.array(legSchema),
    calculatedRisk: z.number().optional(),
})

export const navigationResponseSchema = z.object({
    requestParameters: z.record(z.unknown()),
    debugOutput: z.record(z.unknown()),
    from: nodeSchema,
    to: nodeSchema,
    direct: z.array(z.unknown()).default([]),
    safestItinerary: itinerarySchema,
    alternativeItineraries: z.array(itinerarySchema),
})

export type Itinerary = z.infer<typeof itinerarySchema>
export type NavigationResponse = z.infer<typeof navigationResponseSchema>
export type Leg = z.infer<typeof legSchema>
export type Node = z.infer<typeof nodeSchema>

export const getItineraries = async (network: string, start: string, end: string) => {
    const { data } = await client.get('/v0/transit/itineraries', {
        params: { network, startStation: start, endStation: end },
    })
    const result = navigationResponseSchema.safeParse(data)

    if (!result.success) {
        return undefined
    }

    return result.data
}

export const api = {
    getNetworks,
    getLines,
    getLinesMetadata,
    getStations,
    getReports,
    getRecentReports,
    postReport,
    getRiskData,
    getStationStatistics,
    getSegments,
    getItineraries,
}
