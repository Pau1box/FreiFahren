import { useQuery } from '@tanstack/react-query'
import { createContext, PropsWithChildren, useContext, useEffect, useMemo, useRef } from 'react'

import { api, Network } from './api/client'
import { CACHE_KEYS } from './api/queryClient'
import { useAppStore } from './app.store'
import { containsCoordinates, useDeviceLocation } from './location'

/**
 * Only used when the deployment serves a network we cannot pick between, mirroring the server side
 * default. Nothing else in the app may assume this network exists.
 */
const FALLBACK_NETWORK_ID = 'berlin'

export const useNetworks = () =>
    useQuery({
        queryKey: CACHE_KEYS.networks,
        queryFn: api.getNetworks,
        staleTime: Infinity,
    })

/**
 * The selection order from the multi network contract: the network the user chose, otherwise the one
 * whose bounds contain the device, otherwise the fallback. A location inside two networks decides
 * nothing, so it is treated as no answer.
 */
const resolveNetwork = (
    networks: Network[],
    selectedNetworkId: string | null,
    coordinates: Parameters<typeof containsCoordinates>[1] | undefined
): Network | undefined => {
    const selected = networks.find(({ id }) => id === selectedNetworkId)

    if (selected !== undefined) return selected

    if (coordinates !== undefined) {
        const matching = networks.filter(({ bounds }) => containsCoordinates(bounds, coordinates))

        if (matching.length === 1) return matching[0]
    }

    return networks.find(({ id }) => id === FALLBACK_NETWORK_ID) ?? networks[0]
}

type NetworkContextValue = {
    networks: Network[]
    /** Undefined until the network is resolved. Data queries stay disabled while it is. */
    activeNetwork: Network | undefined
    selectNetwork: (networkId: string) => void
}

const NetworkContext = createContext<NetworkContextValue>({
    networks: [],
    activeNetwork: undefined,
    selectNetwork: () => {},
})

export const NetworkProvider = ({ children }: PropsWithChildren) => {
    const { data: networks } = useNetworks()
    const selectedNetworkId = useAppStore((state) => state.networkId)
    const updateAppStore = useAppStore((state) => state.update)
    const location = useDeviceLocation()

    const value = useMemo((): NetworkContextValue => {
        // Resolving before the location is known would pick the fallback for someone who is in
        // another city, and the app would then have to throw its first responses away.
        const canResolve = networks !== undefined && (selectedNetworkId !== null || location.status !== 'pending')

        return {
            networks: networks ?? [],
            activeNetwork: canResolve
                ? resolveNetwork(
                      networks,
                      selectedNetworkId,
                      location.status === 'resolved' ? location.coordinates : undefined
                  )
                : undefined,
            selectNetwork: (networkId: string) => updateAppStore({ networkId }),
        }
    }, [networks, selectedNetworkId, location, updateAppStore])

    /*
     A report belongs to the network it was made in: its station id resolves to nothing in the next
     one, which would leave the details sheet showing an empty station name and reporting the wrong
     station to analytics. Resetting here covers every way the active network can change.
    */
    const activeNetworkId = value.activeNetwork?.id
    const previousNetworkId = useRef(activeNetworkId)

    useEffect(() => {
        const hadNetwork = previousNetworkId.current !== undefined

        if (previousNetworkId.current === activeNetworkId) return

        previousNetworkId.current = activeNetworkId

        // The first network is not a switch: there is nothing chosen yet to discard.
        if (hadNetwork) updateAppStore({ reportToShow: null })
    }, [activeNetworkId, updateAppStore])

    return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>
}

export const useActiveNetwork = () => useContext(NetworkContext).activeNetwork

export const useNetworkSelection = () => {
    const { networks, activeNetwork, selectNetwork } = useContext(NetworkContext)

    return { networks, activeNetwork, selectNetwork }
}
