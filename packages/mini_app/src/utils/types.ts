export interface StationProperty {
    name: string
    coordinates: {
        latitude: number
        longitude: number
    }
    lines: string[]
}

export type StationList = Record<string, StationProperty>
export type LinesList = Record<string, string[]>

export type LineMode = 'subway' | 'light_rail' | 'tram' | 'train' | 'unknown'

export interface LineMetadata {
    color: string
    mode: LineMode
    isCircular: boolean
}

export type LineMetadataList = Record<string, LineMetadata>

export interface Coordinates {
    latitude: number
    longitude: number
}

export interface Network {
    id: string
    name: string
    countryCode: string
    timezone: string
    center: Coordinates
    bounds: {
        southWest: Coordinates
        northEast: Coordinates
    }
    status: 'active' | 'beta'
    /**
     * The other cities this network reaches, for example Dortmund and Essen for the Rhine-Ruhr
     * network that is filed under Düsseldorf. Always present, possibly empty.
     */
    serves: string[]
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
