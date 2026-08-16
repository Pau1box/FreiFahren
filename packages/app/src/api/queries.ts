import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { z } from 'zod'

import { config } from '../config'
import { useActiveNetwork } from '../networks'
import { api, FeatureCollection, Lines, LinesMetadata, Report, RiskData, Stations, StationStatistics } from './client'
import { CACHE_KEYS } from './queryClient'

export const useLines = <T = Lines>(select?: (data: Lines) => T) => {
    const network = useActiveNetwork()

    return useQuery({
        queryKey: CACHE_KEYS.lines(network?.id),
        queryFn: () => api.getLines(network!.id),
        staleTime: Infinity,
        select,
        enabled: network !== undefined,
    })
}

export const useLinesMetadata = <T = LinesMetadata>(select?: (data: LinesMetadata) => T) => {
    const network = useActiveNetwork()

    return useQuery({
        queryKey: CACHE_KEYS.linesMetadata(network?.id),
        queryFn: () => api.getLinesMetadata(network!.id),
        staleTime: Infinity,
        select,
        enabled: network !== undefined,
    })
}

export const useSegments = <T = FeatureCollection>(select?: (data: FeatureCollection) => T) => {
    const network = useActiveNetwork()

    return useQuery({
        queryKey: CACHE_KEYS.segments(network?.id),
        queryFn: () => api.getSegments(network!.id),
        staleTime: Infinity,
        select,
        enabled: network !== undefined,
    })
}

export const useStations = <T = Stations>(select?: (data: Stations) => T) => {
    const network = useActiveNetwork()

    return useQuery({
        queryKey: CACHE_KEYS.stations(network?.id),
        queryFn: () => api.getStations(network!.id),
        staleTime: Infinity,
        select,
        enabled: network !== undefined,
    })
}

export const useReports = <T = Report[]>(select?: (data: Report[]) => T) => {
    const network = useActiveNetwork()

    return useQuery({
        queryKey: CACHE_KEYS.reports(network?.id),
        queryFn: () => api.getRecentReports(network!.id),
        staleTime: 1000 * 10,
        select,
        refetchInterval: 1000 * 10,
        enabled: network !== undefined,
    })
}

export const useSubmitReport = () => {
    const queryClient = useQueryClient()
    const network = useActiveNetwork()

    return useMutation({
        mutationFn: (report: Parameters<typeof api.postReport>[1]) => api.postReport(network!.id, report),
        onSuccess: async (newReport: Report) => {
            queryClient.setQueryData(CACHE_KEYS.reports(network?.id), (oldReports: Report[] | undefined) => [
                ...(oldReports ?? []),
                newReport,
            ])

            return newReport
        },
    })
}

export const useRiskData = <T = RiskData>(select?: (data: RiskData) => T) => {
    const network = useActiveNetwork()

    return useQuery({
        queryKey: CACHE_KEYS.risk(network?.id),
        queryFn: () => api.getRiskData(network!.id),
        staleTime: 1000 * 60,
        select,
        refetchInterval: 1000 * 60,
        enabled: network !== undefined,
    })
}

export const usePrivacyPolicyMeta = () =>
    useQuery({
        queryKey: CACHE_KEYS.privacyPolicyMeta,
        queryFn: async () => {
            const { data } = await axios.get(config.PRIVACY_POLICY_META_URL)

            return z
                .object({
                    lastModified: z.string().transform((date) => new Date(date)),
                    version: z.number(),
                })
                .parse(data)
        },
    })

export const useStationStatistics = <T = StationStatistics>(
    stationId: string | undefined,
    select?: (data: StationStatistics) => T
) => {
    const network = useActiveNetwork()

    return useQuery({
        queryKey: CACHE_KEYS.stationStatistics(network?.id, stationId),
        queryFn: () => api.getStationStatistics(network!.id, stationId!),
        staleTime: 1000 * 60,
        select,
        enabled: stationId !== undefined && network !== undefined,
    })
}

export const useItineraries = (start: string | undefined, end: string | undefined) => {
    const network = useActiveNetwork()

    return useQuery({
        queryKey: CACHE_KEYS.itineraries(network?.id, start, end),
        queryFn: () => api.getItineraries(network!.id, start!, end!),
        enabled: start !== undefined && end !== undefined && network !== undefined,
    })
}
