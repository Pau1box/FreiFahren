import { useMutation, useQuery } from '@tanstack/react-query';
import { useNetworkId } from '../network/NetworkContext';
import { compareLineNames, MODE_ORDER } from '../utils/lines';
import type { LineMetadataList, LinesList, Network, Report, StationList } from '../utils/types';

// Ids are only unique inside their network, so everything that holds transit data is keyed by it.
// Without that, switching cities would serve the previous city's stations and lines from cache.
export const CACHE_KEYS = {
  networks: ['networks'],
  stations: (networkId: string) => ['stationsETag', networkId],
  lines: (networkId: string) => ['linesETag', networkId],
  lineMetadata: (networkId: string) => ['lineMetadata', networkId],
};

/**
 * The network is required rather than defaulted, so that a caller cannot silently ask for Berlin.
 * The same path answers differently per network, so the stored ETag and the stored body are keyed by
 * it too: without that, Hamburg would be answered from Berlin's cache.
 */
export const fetchWithETag = async <T>(endpoint: string, storageKeyPrefix: string, network: string): Promise<T> => {
    const scopedPrefix = `${storageKeyPrefix}_${network}`;
    const etagKey = `${scopedPrefix}ETag`;
    const dataKey = `${scopedPrefix}Data`;
    const cachedETag: string | null = localStorage.getItem(etagKey);
    const cachedData: string | null = localStorage.getItem(dataKey);

    const headers: HeadersInit = {
        Accept: 'application/json',
    };
    /*
     An ETag is only worth sending while the body it stands for is still there. A 304 has no body, so
     claiming a copy we no longer hold would answer nothing and leave the view empty for good.
    */
    if (cachedETag !== null && cachedETag !== '' && cachedData !== null) {
        headers['If-None-Match'] = cachedETag;
    }

    const url = `${import.meta.env.VITE_API_URL}${endpoint}?network=${encodeURIComponent(network)}`;

    const response: Response = await fetch(url, { headers });

    if (response.status === 304 && cachedData !== null) {
        try {
            return JSON.parse(cachedData) as T;
        } catch {
            // A body we cannot read is no body: drop the pair so the retry asks for a full response.
            localStorage.removeItem(etagKey);
            localStorage.removeItem(dataKey);
            throw new Error(`Failed to read the cached response for ${endpoint}`);
        }
    }

    if (!response.ok) {
        throw new Error(`Failed to fetch data: ${response.status}`);
    }

    const newData = (await response.json()) as T;
    const newETag: string | null = response.headers.get('ETag');

    /*
     Every network keeps its own copy, so the shared storage quota is reached far sooner than with a
     single one. A full quota must not take the data we just fetched down with it, and the body is
     written before the ETag so that an ETag never outlives it.
    */
    try {
        localStorage.setItem(dataKey, JSON.stringify(newData));
        if (newETag !== null) {
            localStorage.setItem(etagKey, newETag);
        }
    } catch {
        localStorage.removeItem(etagKey);
        localStorage.removeItem(dataKey);
    }

    return newData;
};

export const useNetworks = () =>
    useQuery<Network[], Error>({
        queryKey: CACHE_KEYS.networks,
        queryFn: async (): Promise<Network[]> => {
            const response = await fetch(`${import.meta.env.VITE_API_URL}/v0/networks`);

            if (!response.ok) {
                throw new Error(`Failed to fetch networks: ${response.status}`);
            }

            return (await response.json()) as Network[];
        },
        staleTime: Infinity,
        gcTime: Infinity,
        refetchOnWindowFocus: false,
    });

export const useStations = () => {
    const networkId = useNetworkId();

    return useQuery<StationList, Error>({
        queryKey: CACHE_KEYS.stations(networkId),
        queryFn: () => fetchWithETag<StationList>('/v0/stations', 'stations', networkId),
        staleTime: Infinity,
        gcTime: Infinity,
        refetchOnWindowFocus: false,
    });
};

export const useLineMetadata = () => {
    const networkId = useNetworkId();

    return useQuery<LineMetadataList, Error>({
        queryKey: CACHE_KEYS.lineMetadata(networkId),
        queryFn: () => fetchWithETag<LineMetadataList>('/v0/lines/metadata', 'lineMetadata', networkId),
        staleTime: Infinity,
        gcTime: Infinity,
        refetchOnWindowFocus: false,
    });
};

export const useLines = () => {
    const networkId = useNetworkId();
    const { data: metadata } = useLineMetadata();

    return useQuery<LinesList, Error, [string, string[]][]>({
        queryKey: CACHE_KEYS.lines(networkId),
        queryFn: () => fetchWithETag<LinesList>('/v0/lines', 'lines', networkId),
        // Group by what a line is, not by what it is called: a leading S or U means a different mode
        // of transport from one city to the next. Sorting sits in `select` so that it runs again once
        // the metadata has arrived.
        select: (data): [string, string[]][] => {
            const groupPriority = (line: string): number => {
                const index = MODE_ORDER.indexOf(metadata?.[line]?.mode ?? 'unknown');

                return index === -1 ? MODE_ORDER.length : index;
            };

            return Object.entries(data).sort((a, b) => {
                const groupA = groupPriority(a[0]);
                const groupB = groupPriority(b[0]);
                if (groupA !== groupB) {
                    return groupA - groupB;
                }
                return compareLineNames(a[0], b[0]);
            });
        },
        staleTime: Infinity,
        gcTime: Infinity,
        refetchOnWindowFocus: false,
        structuralSharing: true,
    });
};

export const useSubmitReport = () => {
    const networkId = useNetworkId();

    return useMutation({
        mutationFn: async (report: Report) => {
            const requestBody = {
                timestamp: new Date(report.timestamp),
                line: report.line ?? '',
                stationId: report.station.id,
                directionId: report.direction?.id ?? '',
                message: report.message ?? '',
                author: 77105110105, // ascii for Mini
            };

            const response = await fetch(
                `${import.meta.env.VITE_API_URL}/v0/basics/inspectors?network=${encodeURIComponent(networkId)}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(requestBody),
                }
            );

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            return (await response.json()) as Report;
        },
    });
};
