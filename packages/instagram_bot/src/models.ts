export interface Inspector {
    timestamp: string
    station: Station
    direction: Station
    line: string
    isHistoric: boolean
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

// `GET /v0/lines/metadata`, keyed by line. Only the colour is used here, the rest is what the
// endpoint carries for every client.
export type LineColors = Record<string, { color: string; mode: string; isCircular: boolean }>

// `GET /v0/networks`. Only the id and the timezone are used here, the rest is the geography a map
// client needs.
export interface Network {
    id: string
    timezone: string
}

export interface TokenResponse {
    access_token: string
}

export interface TokenData {
    accessToken: string
    expiresAt: number
}

export interface PageData {
    access_token: string
    instagram_business_account: {
        id: string
    }
    id: string
}

export interface MediaContainerResponse {
    id: string
}

export interface PublishMediaResponse {
    id: string
}
