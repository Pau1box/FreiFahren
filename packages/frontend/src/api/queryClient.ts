import { QueryClient } from '@tanstack/react-query'

/*
 Ids are only unique inside their network, so every key that holds transit data carries the network
 id. Without it, switching to another city would show the previous one's lines and stations from the
 cache.
*/
/** Null while the network list is still loading. Queries keyed that way stay disabled. */
type NetworkKey = string | null

export const CACHE_KEYS = {
    networks: ['networks'] as const,
    reports: (network: NetworkKey) => ['reports', network] as const,
    byTimeframe: (network: NetworkKey, timeframe: '24h' | '1h') => ['reports', network, timeframe] as const,
    stations: (network: NetworkKey) => ['stations', network] as const,
    lines: (network: NetworkKey) => ['lines', network] as const,
    lineMetadata: (network: NetworkKey) => ['line-metadata', network] as const,
    risk: (network: NetworkKey) => ['risk', network] as const,
    segments: (network: NetworkKey) => ['segments', network] as const,
    stationReports: (network: NetworkKey, stationId: string) => ['station-reports', network, stationId] as const,
    stationDistance: (network: NetworkKey, stationId: string, userLat: number, userLng: number) =>
        ['station-distance', network, stationId, userLat, userLng] as const,
    navigation: (network: NetworkKey, startStationId: string, endStationId: string) =>
        ['navigation', network, startStationId, endStationId] as const,
}

export const queryClient = new QueryClient({
    defaultOptions: {
        queries: {},
    },
})
