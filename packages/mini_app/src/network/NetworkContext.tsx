import { createContext, FC, ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { useNetworks } from '../api/queries';
import type { Network } from '../utils/types';

const STORAGE_KEY = 'freifahren.networkId';

/**
 * Only used when the user has not chosen a network, mirroring the server side default. The mini app
 * has no location, so the contract's middle step (the network containing the user) does not apply
 * here and the choice is either the stored one or this.
 */
const FALLBACK_NETWORK_ID = 'berlin';

interface NetworkContextValue {
    networks: Network[];
    networkId: string;
    network: Network | undefined;
    selectNetwork: (networkId: string) => void;
}

const NetworkContext = createContext<NetworkContextValue>({
    networks: [],
    networkId: FALLBACK_NETWORK_ID,
    network: undefined,
    selectNetwork: () => {},
});

export const NetworkProvider: FC<{ children: ReactNode }> = ({ children }) => {
    const { data: networks } = useNetworks();
    const [selectedNetworkId, setSelectedNetworkId] = useState<string | null>(() =>
        localStorage.getItem(STORAGE_KEY)
    );

    const selectNetwork = useCallback((networkId: string) => {
        localStorage.setItem(STORAGE_KEY, networkId);
        setSelectedNetworkId(networkId);
    }, []);

    const value = useMemo((): NetworkContextValue => {
        const available = networks ?? [];
        // The stored choice is trusted until the list proves it gone, so the first requests do not go
        // out for the wrong city while the list is still loading. A network the deployment dropped
        // would answer 404 on every request, hence the check once the list is there.
        const isStillServed = networks === undefined || available.some(({ id }) => id === selectedNetworkId);
        // A deployment that does not serve the fallback would otherwise 404 on every request, so once
        // the list is there the first network it names stands in.
        const defaultNetworkId =
            networks !== undefined && !available.some(({ id }) => id === FALLBACK_NETWORK_ID) && available.length > 0
                ? available[0].id
                : FALLBACK_NETWORK_ID;
        const networkId = selectedNetworkId !== null && isStillServed ? selectedNetworkId : defaultNetworkId;

        return {
            networks: available,
            networkId,
            network: available.find(({ id }) => id === networkId),
            selectNetwork,
        };
    }, [networks, selectedNetworkId, selectNetwork]);

    return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
};

export const useNetworkId = (): string => useContext(NetworkContext).networkId;

export const useNetworkSelection = (): NetworkContextValue => useContext(NetworkContext);
