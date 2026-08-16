import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useNetworkId } from 'src/contexts/NetworkContext'
import { compareLines } from 'src/utils/lineModes'
import { Itinerary, LineMetadataList, LinesList, Position, Report, RiskData, StationList } from 'src/utils/types'

import { useSkeleton } from '../components/Miscellaneous/LoadingPlaceholder/Skeleton'
import { getClosestStations } from '../hooks/getClosestStations'
import { sendAnalyticsEvent } from '../hooks/useAnalytics'
import { CACHE_KEYS } from './queryClient'

/**
 * Builds an API url with the network the request is scoped to. New client code always sends the
 * parameter explicitly, even for the default network, so that the server side default never becomes
 * load bearing.
 */
const buildApiUrl = (endpoint: string, networkId: string, params: Record<string, string | undefined> = {}): string => {
    const searchParams = new URLSearchParams({ network: networkId })

    Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value.trim() !== '') {
            searchParams.append(key, value)
        }
    })

    return `${import.meta.env.VITE_API_URL}${endpoint}?${searchParams.toString()}`
}

const fetchNewReports = async (
    networkId: string,
    startTime?: string,
    endTime?: string,
    stationId?: string,
    lastKnownTimestamp?: string
): Promise<Report[] | null> => {
    const headers: HeadersInit = {
        'Content-Type': 'application/json',
    }

    if (lastKnownTimestamp !== undefined && lastKnownTimestamp.trim() !== '') {
        const date = new Date(lastKnownTimestamp)

        headers['If-Modified-Since'] = date.toUTCString()
    }

    const response = await fetch(
        buildApiUrl('/v0/basics/inspectors', networkId, { start: startTime, end: endTime, station: stationId }),
        { headers }
    )

    if (response.status === 304) {
        return null
    }

    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
    }

    return response.json()
}

export const useReportsByStation = (stationId: string, startTime?: string, endTime?: string) => {
    const networkId = useNetworkId()

    return useQuery({
        queryKey: [...CACHE_KEYS.reports(networkId), stationId, startTime, endTime],
        queryFn: () => fetchNewReports(networkId!, startTime, endTime, stationId),
        /*
         Without a station the endpoint answers with the whole network, which the caller would show
         as this station's reports. That is what an id from another network resolves to after a
         switch, so it has to stay unasked.
        */
        enabled: networkId !== null && stationId.trim() !== '',
    })
}

interface SubmitReportOptions {
    duration?: number
    meta?: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        [key: string]: any
    }
}

export const useSubmitReport = (options?: SubmitReportOptions) => {
    const queryClient = useQueryClient()
    const networkId = useNetworkId()

    return useMutation({
        mutationFn: async (report: Report) => {
            if (networkId === null) {
                throw new Error('Cannot submit a report before the network is known')
            }

            const requestBody = {
                timestamp: new Date(report.timestamp),
                line: report.line ?? '',
                stationId: report.station.id,
                directionId: report.direction?.id ?? '',
                message: report.message ?? '',
            }

            const response = await fetch(buildApiUrl('/v0/basics/inspectors', networkId), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
            })

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}))
                const error = new Error(errorData.message ?? `HTTP error! status: ${response.status}`)

                error.name = response.status.toString()
                throw error
            }

            return response.json()
        },
        onSuccess: (_, variables) => {
            sendAnalyticsEvent('Report Submitted', {
                meta: {
                    ...options?.meta,
                    station: variables.station.name,
                    line: variables.line,
                    direction: variables.direction?.name,
                    hasMessage: !!variables.message,
                },
                duration: options?.duration,
            })
            // Invalidate relevant queries to refetch data
            queryClient.invalidateQueries({ queryKey: CACHE_KEYS.reports(networkId) })
        },
        onError: (error: Error) => {
            // as a quick solution until we have a proper error monitoring set up
            sendAnalyticsEvent('Report Submission Failed', {
                meta: {
                    error: error.message,
                    status: error.name,
                },
            })
        },
    })
}

export const useFeedback = () =>
    useMutation({
        mutationFn: async (feedback: string): Promise<boolean> => {
            if (!feedback.trim()) {
                return false
            }

            const response = await fetch(`${import.meta.env.VITE_API_URL}/v0/feedback`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ feedback }),
            })
            return response.ok
        },
    })

export const useCurrentReports = () => {
    const queryClient = useQueryClient()
    const networkId = useNetworkId()
    const queryResult = useQuery<Report[], Error>({
        queryKey: CACHE_KEYS.byTimeframe(networkId, '1h'),
        queryFn: async (): Promise<Report[]> => {
            const endTime = new Date().toISOString()
            const startTime = new Date(new Date(endTime).getTime() - 60 * 60 * 1000).toISOString()

            // Get previous data from the queryClient instead of destructuring from outer scope.
            const prevData = queryClient.getQueryData<Report[]>(CACHE_KEYS.byTimeframe(networkId, '1h')) ?? []
            const lastKnownTimestamp = prevData[0]?.timestamp

            const result = await fetchNewReports(networkId!, startTime, endTime, undefined, lastKnownTimestamp)
            const newData = result === null ? prevData : result

            // If we got new data, invalidate the risk cache (temporary fix to avoid race condition)
            if (result !== null) {
                setTimeout(() => {
                    queryClient.invalidateQueries({ queryKey: CACHE_KEYS.risk(networkId) })
                }, 2.5 * 1000)
            }

            // Separate historic and non-historic reports
            const historicReports = newData.filter((report) => report.isHistoric)
            const currentReports = newData.filter((report) => !report.isHistoric)

            // Sort each group by timestamp (newest first)
            const sortedCurrentReports = currentReports.sort(
                (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
            )
            const sortedHistoricReports = historicReports.sort(
                (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
            )

            /*
             Combine the sorted groups: current reports first, then historic
             Necessary because historic reports have a guessed timestamp of between 45 and 60 minutes ago
             This means that sometimes the historic reports will be returned first, but we should always
             show the real reports first.
            */
            return [...sortedCurrentReports, ...sortedHistoricReports]
        },
        enabled: networkId !== null,
        refetchInterval: 15 * 1000,
        staleTime: 2.5 * 60 * 1000,
        structuralSharing: true,
    })

    return {
        data: queryResult.data,
        error: queryResult.error,
        isLoading: queryResult.isLoading,
        isFetching: queryResult.isFetching,
        refetch: queryResult.refetch,
    }
}

export const useLast24HourReports = () => {
    const { data: lastHourReports = [] } = useCurrentReports()
    const queryClient = useQueryClient()
    const networkId = useNetworkId()

    const queryResult = useQuery<Report[], Error>({
        queryKey: CACHE_KEYS.byTimeframe(networkId, '24h'),
        queryFn: async (): Promise<Report[]> => {
            const endTime = new Date().toISOString()
            const startTime = new Date(new Date(endTime).getTime() - 24 * 60 * 60 * 1000).toISOString()

            // Retrieve previous 24h reports via queryClient instead of outer scope.
            const prevData = queryClient.getQueryData<Report[]>(CACHE_KEYS.byTimeframe(networkId, '24h')) ?? []
            const lastKnownTimestamp = prevData[0]?.timestamp

            const result = await fetchNewReports(networkId!, startTime, endTime, undefined, lastKnownTimestamp)
            const newData = result === null ? prevData : result

            // Remove the most recent hour, as that is replaced by current reports.
            const oneHourAgo = Date.now() - 60 * 60 * 1000

            return newData.filter((report) => new Date(report.timestamp).getTime() < oneHourAgo)
        },
        enabled: networkId !== null,
        refetchInterval: 2 * 60 * 1000,
        staleTime: 5 * 60 * 1000,
        structuralSharing: true,
        placeholderData: keepPreviousData,
    })
    /*
     Combine the data: most recent hour first, then the rest of the 24h period
     becuase of fullDayReports wont contain historic data, (see docs for more info),
     this would cause the Last24HourReports to be misaligned with the current reports
    */
    const fullDayReports = useMemo(() => queryResult.data ?? [], [queryResult.data])

    fullDayReports.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    const { isPlaceholderData } = queryResult

    const data = useMemo(() => {
        if (isPlaceholderData) return lastHourReports
        return [...lastHourReports, ...fullDayReports]
    }, [lastHourReports, fullDayReports, isPlaceholderData])

    return {
        data,
        isPlaceholderData,
        error: queryResult.error,
        isLoading: queryResult.isLoading,
    }
}

export const useRiskData = () => {
    const networkId = useNetworkId()
    const queryResult = useQuery<RiskData, Error>({
        queryKey: CACHE_KEYS.risk(networkId),
        queryFn: async (): Promise<RiskData> => {
            const response = await fetch(buildApiUrl('/v1/risk-prediction/segment-colors', networkId!))

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`)
            }

            return response.json()
        },
        enabled: networkId !== null,
        refetchInterval: 30 * 1000,
        staleTime: 60 * 1000,
        structuralSharing: true,
    })

    return {
        data: queryResult.data ?? { segments_risk: {} },
        error: queryResult.error,
        isLoading: queryResult.isLoading,
        refetch: queryResult.refetch,
    }
}

/**
 * The conditional request cache is stored per network: a station list keyed only by endpoint would
 * answer Hamburg with Berlin's stations after a switch.
 */
export const fetchWithETag = async <T>(endpoint: string, storageKeyPrefix: string, networkId: string): Promise<T> => {
    const etagKey = `${storageKeyPrefix}.${networkId}.ETag`
    const dataKey = `${storageKeyPrefix}.${networkId}.Data`
    const cachedETag: string | null = localStorage.getItem(etagKey)
    const cachedData: string | null = localStorage.getItem(dataKey)

    const headers: HeadersInit = {
        Accept: 'application/json',
    }
    /*
     An ETag is only worth sending while the body it stands for is still there. A 304 has no body, so
     claiming a copy we no longer hold would answer nothing and leave the view empty for good.
    */
    if (cachedETag !== null && cachedETag !== '' && cachedData !== null) {
        headers['If-None-Match'] = cachedETag
    }

    const response: Response = await fetch(buildApiUrl(endpoint, networkId), { headers })

    if (response.status === 304 && cachedData !== null) {
        try {
            return JSON.parse(cachedData) as T
        } catch {
            // A body we cannot read is no body: drop the pair so the retry asks for a full response.
            localStorage.removeItem(etagKey)
            localStorage.removeItem(dataKey)
            throw new Error(`Failed to read the cached response for ${endpoint}`)
        }
    }

    if (!response.ok) {
        throw new Error(`Failed to fetch data: ${response.status}`)
    }

    const newData: T = await response.json()
    const newETag: string | null = response.headers.get('ETag')

    /*
     Every network keeps its own copy, so the shared storage quota is reached far sooner than with a
     single one. A full quota must not take the data we just fetched down with it, and the body is
     written before the ETag so that an ETag never outlives it.
    */
    try {
        localStorage.setItem(dataKey, JSON.stringify(newData))
        if (newETag !== null) {
            localStorage.setItem(etagKey, newETag)
        }
    } catch {
        localStorage.removeItem(etagKey)
        localStorage.removeItem(dataKey)
    }

    return newData
}

export const useSegments = () => {
    const networkId = useNetworkId()

    return useQuery<GeoJSON.FeatureCollection<GeoJSON.LineString>, Error>({
        queryKey: CACHE_KEYS.segments(networkId),
        queryFn: () =>
            fetchWithETag<GeoJSON.FeatureCollection<GeoJSON.LineString>>('/v0/lines/segments', 'segments', networkId!),
        enabled: networkId !== null,
        staleTime: Infinity,
        gcTime: Infinity,
        refetchOnWindowFocus: false,
    })
}

export const useStations = () => {
    const networkId = useNetworkId()

    return useQuery<StationList, Error>({
        queryKey: CACHE_KEYS.stations(networkId),
        queryFn: () => fetchWithETag<StationList>('/v0/stations', 'stations', networkId!),
        enabled: networkId !== null,
        staleTime: Infinity,
        gcTime: Infinity,
        refetchOnWindowFocus: false,
    })
}

/** Colour and mode of every line in the active network. Replaces the per city colour table. */
export const useLineMetadata = () => {
    const networkId = useNetworkId()

    return useQuery<LineMetadataList, Error>({
        queryKey: CACHE_KEYS.lineMetadata(networkId),
        queryFn: () => fetchWithETag<LineMetadataList>('/v0/lines/metadata', 'lineMetadata', networkId!),
        enabled: networkId !== null,
        staleTime: Infinity,
        gcTime: Infinity,
        refetchOnWindowFocus: false,
    })
}

export const useLines = () => {
    const networkId = useNetworkId()
    const { data: lineMetadata } = useLineMetadata()

    const queryResult = useQuery<LinesList, Error>({
        queryKey: CACHE_KEYS.lines(networkId),
        queryFn: () => fetchWithETag<LinesList>('/v0/lines', 'lines', networkId!),
        enabled: networkId !== null,
        staleTime: Infinity,
        gcTime: Infinity,
        refetchOnWindowFocus: false,
        structuralSharing: true,
    })

    const { data } = queryResult
    const sortedEntries = useMemo(
        () =>
            data === undefined
                ? undefined
                : Object.entries(data).sort(([a], [b]) => compareLines(a, b, lineMetadata ?? {})),
        [data, lineMetadata]
    )

    return {
        data: sortedEntries,
        error: queryResult.error,
        isLoading: queryResult.isLoading,
    }
}

export interface UseStationDistanceResult {
    distance: number | null
    isLoading: boolean
    shouldShowSkeleton: boolean
}

export const useStationDistance = (
    stationId: string,
    allStations: StationList,
    userLat?: number,
    userLng?: number
): UseStationDistanceResult => {
    const networkId = useNetworkId()
    const { data: distance, isLoading } = useQuery<number | null>({
        /*
         The station list is an input of the lookup, not part of its identity: putting the whole
         object in the key rebuilds it on every render and starts a fresh query for an unchanged
         station. Which stations exist is decided by the network, and that is in the key. The query
         only runs with both coordinates present, so the zeros are never used.
        */
        // eslint-disable-next-line @tanstack/query/exhaustive-deps
        queryKey: CACHE_KEYS.stationDistance(networkId, stationId, userLat ?? 0, userLng ?? 0),
        queryFn: async () => {
            if (
                userLat === undefined ||
                Number.isNaN(userLat) ||
                userLng === undefined ||
                Number.isNaN(userLng) ||
                stationId.trim() === ''
            ) {
                return null
            }
            const stationsArray = Object.entries(allStations).map(([id, station]) => ({
                id,
                ...station,
            }))
            const [userStation] = getClosestStations(1, stationsArray, { lat: userLat, lng: userLng })
            const response = await fetch(
                buildApiUrl('/v0/transit/distance', networkId!, {
                    inspectorStationId: stationId,
                    userStationId: userStation.id,
                })
            )
            const data = await response.json()

            if (typeof data === 'number') return data
            return data.distance
        },
        enabled:
            networkId !== null &&
            typeof userLat === 'number' &&
            !Number.isNaN(userLat) &&
            typeof userLng === 'number' &&
            !Number.isNaN(userLng) &&
            stationId.trim() !== '',
    })

    /*
     Apply skeleton showing logic using our custom useSkeleton hook.
     This prevents flickering for fast responses by ensuring the skeleton is shown for a minimum time.
    */
    const shouldShowSkeleton = useSkeleton({
        isLoading,
        initialDelay: 100,
        minDisplayTime: 1000,
    })

    return {
        distance: distance ?? null,
        isLoading,
        shouldShowSkeleton,
    }
}

export const useStationReports = (stationId: string) => {
    const networkId = useNetworkId()

    return useQuery<number, Error>({
        queryKey: CACHE_KEYS.stationReports(networkId, stationId),
        queryFn: async () => {
            const response = await fetch(
                buildApiUrl(`/v0/stations/${encodeURIComponent(stationId)}/statistics`, networkId!)
            )

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`)
            }
            const data = await response.json()

            return data.numberOfReports as number
        },
        enabled: networkId !== null,
    })
}

export type NavigationResponse = {
    requestParameters: Record<string, unknown>
    debugOutput: Record<string, unknown>
    from: Position
    to: Position
    direct: unknown[]
    safestItinerary: Itinerary
    alternativeItineraries: Itinerary[]
}

export const useNavigation = (startStationId: string, endStationId: string, options?: { enabled?: boolean }) => {
    const networkId = useNetworkId()

    return useQuery<NavigationResponse, Error>({
        queryKey: CACHE_KEYS.navigation(networkId, startStationId, endStationId),
        queryFn: async () => {
            if (!startStationId || !endStationId) {
                return null
            }

            const response = await fetch(
                buildApiUrl('/v0/transit/itineraries', networkId!, {
                    startStation: startStationId,
                    endStation: endStationId,
                })
            )

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`)
            }
            const data = await response.json()

            return data
        },
        enabled: networkId !== null && options?.enabled !== false,
    })
}
