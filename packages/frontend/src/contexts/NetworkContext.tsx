import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useNetworks } from 'src/api/networks'
import { isPositionInBounds } from 'src/utils/mapUtils'
import { Network } from 'src/utils/types'

import { useLocation } from './LocationContext'

const STORAGE_KEY = 'network'

/**
 * A shared link carries the network it was taken from, because a station id alone means nothing
 * outside it. It only decides the current visit and is deliberately not stored: it says which city
 * the sender was looking at, not which one the recipient wants by default. A link without the
 * parameter, as every link shared before this existed, falls through to the usual order.
 */
export const NETWORK_URL_PARAM = 'network'

const networkIdFromUrl = (): string | null => new URLSearchParams(window.location.search).get(NETWORK_URL_PARAM)

/**
 * The last resort of the selection order. It only applies when the user has never chosen a network
 * and their location does not identify one; a deployment without Berlin falls through to its first
 * network instead.
 */
const FALLBACK_NETWORK_ID = 'berlin'

interface NetworkContextType {
    networks: Network[]
    /** The active network, or null while the list is still loading. */
    network: Network | null
    /** Null while the list is loading. Every network scoped request waits for it. */
    networkId: string | null
    selectNetwork: (networkId: string) => void
}

const NetworkContext = createContext<NetworkContextType | undefined>(undefined)

export const useNetwork = () => {
    const context = useContext(NetworkContext)

    if (!context) {
        throw new Error('useNetwork must be used within a NetworkProvider')
    }
    return context
}

/** Convenience for the many queries that only need the id to scope themselves. */
export const useNetworkId = (): string | null => useNetwork().networkId

export const NetworkProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { data: networks } = useNetworks()
    const { userPosition } = useLocation()

    const [chosenNetworkId, setChosenNetworkId] = useState<string | null>(
        () => networkIdFromUrl() ?? localStorage.getItem(STORAGE_KEY)
    )
    const [locatedNetworkId, setLocatedNetworkId] = useState<string | null>(null)

    /*
     Picking by location is a startup convenience, not a cage: it applies once, and only while the
     user has never chosen a network themselves. Without that, walking across a network border would
     drag someone out of the city they are currently looking at.
    */
    useEffect(() => {
        if (chosenNetworkId !== null || locatedNetworkId !== null || userPosition === null || networks === undefined) {
            return
        }

        const containingNetworks = networks.filter((network) => isPositionInBounds(userPosition, network.bounds))

        if (containingNetworks.length === 1) {
            setLocatedNetworkId(containingNetworks[0].id)
        }
    }, [chosenNetworkId, locatedNetworkId, userPosition, networks])

    const network = useMemo((): Network | null => {
        if (networks === undefined || networks.length === 0) return null

        const byId = (networkId: string | null): Network | null =>
            networks.find((candidate) => candidate.id === networkId) ?? null

        return byId(chosenNetworkId) ?? byId(locatedNetworkId) ?? byId(FALLBACK_NETWORK_ID) ?? networks[0]
    }, [networks, chosenNetworkId, locatedNetworkId])

    const selectNetwork = useCallback((networkId: string) => {
        localStorage.setItem(STORAGE_KEY, networkId)
        setChosenNetworkId(networkId)
    }, [])

    return (
        <NetworkContext.Provider
            value={useMemo(
                () => ({
                    networks: networks ?? [],
                    network,
                    networkId: network?.id ?? null,
                    selectNetwork,
                }),
                [networks, network, selectNetwork]
            )}
        >
            {children}
        </NetworkContext.Provider>
    )
}
