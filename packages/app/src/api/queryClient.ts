import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { AxiosError } from 'axios'

import { useAppStore } from '../app.store'
import { track } from '../tracking'

/** Undefined while the active network is still being resolved, which keeps those queries disabled. */
type NetworkId = string | undefined

/**
 * Ids are only unique inside their network, so every key that holds transit data carries the network
 * it was fetched for. Without it, switching cities would render the previous city's lines and stations.
 */
export const CACHE_KEYS = {
    networks: ['networks'],
    reports: (networkId: NetworkId) => ['reports', networkId],
    stations: (networkId: NetworkId) => ['stations', networkId],
    lines: (networkId: NetworkId) => ['lines', networkId],
    linesMetadata: (networkId: NetworkId) => ['lines-metadata', networkId],
    segments: (networkId: NetworkId) => ['segments', networkId],
    risk: (networkId: NetworkId) => ['risk', networkId],
    privacyPolicyMeta: ['privacy-policy-meta'],
    stationStatistics: (networkId: NetworkId, stationId: string | undefined) => [
        'station-statistics',
        networkId,
        stationId,
    ],
    itineraries: (networkId: NetworkId, start: string | undefined, end: string | undefined) => [
        'itineraries',
        networkId,
        start,
        end,
    ],
}

const onError = (error: unknown) => {
    if (error instanceof AxiosError && error.response?.status === 410) {
        track({ name: 'App Deprecated' })
        useAppStore.getState().update({ deprecated: true })
    } else {
        throw error
    }
}

export const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            gcTime: Infinity,
            throwOnError: true,
        },
        mutations: {
            throwOnError: true,
        },
    },
    queryCache: new QueryCache({
        onError,
    }),
    mutationCache: new MutationCache({
        onError,
    }),
})
