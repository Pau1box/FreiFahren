/* eslint-disable @typescript-eslint/no-explicit-any */

export {} // to make this file a module

declare global {
    interface Window {
        pirsch: (eventName: string, options: { duration?: number; meta?: Record<string, any> }) => void
    }
}

export interface AnalyticsMeta {
    [key: string]: any
}

export interface AnalyticsOptions {
    duration?: number
    meta?: AnalyticsMeta
}

export type SavedEvent = {
    eventName: string
    options: AnalyticsOptions
    timestamp: number
}

export interface StationGeoJSON {
    type: string
    features: {
        type: string
        properties: {
            name: string
            lines: string[]
            mode: string
            lineCount: number
        }
        geometry: {
            type: string
            coordinates: number[]
        }
    }[]
}

export interface SegmentRisk {
    color: string
    risk: number
}

export interface Coordinates {
    latitude: number
    longitude: number
}

export interface NetworkBounds {
    southWest: Coordinates
    northEast: Coordinates
}

export type NetworkStatus = 'active' | 'beta'

/** One self contained transit system, as returned by `GET /v0/networks`. */
export interface Network {
    id: string
    name: string
    countryCode: string
    timezone: string
    center: Coordinates
    bounds: NetworkBounds
    status: NetworkStatus
    /**
     * The other cities this network reaches, for example Dortmund and Essen for the Rhine-Ruhr
     * network that is filed under Düsseldorf. Always present, possibly empty.
     */
    serves: string[]
}

/**
 * `unknown` means OpenStreetMap has no route relation for the line, so it is rendered neutrally
 * instead of being guessed from its name.
 */
export type LineMode = 'subway' | 'light_rail' | 'tram' | 'train' | 'unknown'

export interface LineMetadata {
    color: string
    mode: LineMode
    /** Always present: `false` means "not a ring", never "unknown". */
    isCircular: boolean
}

export type LineMetadataList = Record<string, LineMetadata>

export interface StationProperty {
    name: string
    coordinates: {
        latitude: number
        longitude: number
    }
    lines: string[]
}

export interface Station {
    id: string
    name: string
    coordinates: {
        latitude: number
        longitude: number
    }
    lines: string[]
}

export type LineProperty = {
    [key: string]: string[]
}

export type StationList = Record<string, StationProperty>
export type LinesList = Record<string, string[]>
export interface RiskData {
    segments_risk: {
        [key: string]: SegmentRisk
    }
}

export type Report = {
    timestamp: string
    station: {
        id: string
        name: string
        coordinates: {
            latitude: number
            longitude: number
        }
    }
    direction: {
        id: string
        name: string
        coordinates: {
            latitude: number
            longitude: number
        }
    } | null
    line: string | null
    isHistoric: boolean
    message: string | null
}

export type Position = {
    name: string
    stopId: string
    lat: number
    lon: number
    departure?: string
    scheduledDeparture?: string
    arrival?: string
    scheduledArrival?: string
}

export type LegGeometry = {
    points: string
    length: number
}

export type Leg = {
    mode: 'WALK' | 'BUS' | 'TRAM' | 'METRO' | 'SUBWAY' | 'REGIONAL_RAIL'
    from: Position
    to: Position
    duration: number
    startTime: string
    endTime: string
    scheduledStartTime: string
    scheduledEndTime: string
    realTime: boolean
    routeShortName?: string
    intermediateStops?: Position[]
    legGeometry: LegGeometry
}

export type Itinerary = {
    duration: number // in seconds
    startTime: string
    endTime: string
    transfers: number
    legs: Leg[]
    calculatedRisk?: number
}
