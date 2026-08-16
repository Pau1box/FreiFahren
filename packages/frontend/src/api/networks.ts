import { useQuery } from '@tanstack/react-query'
import { Network } from 'src/utils/types'

import { CACHE_KEYS } from './queryClient'

/**
 * The entry point of the API: every other request is scoped to one of these networks, so this is the
 * only fetch that does not carry a network id itself.
 */
export const useNetworks = () =>
    useQuery<Network[], Error>({
        queryKey: CACHE_KEYS.networks,
        queryFn: async (): Promise<Network[]> => {
            const response = await fetch(`${import.meta.env.VITE_API_URL}/v0/networks`)

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`)
            }

            return response.json()
        },
        staleTime: Infinity,
        gcTime: Infinity,
        refetchOnWindowFocus: false,
    })
