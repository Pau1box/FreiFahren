import { FC, useMemo } from 'react';
import { useNetworkSelection } from '../../network/NetworkContext';
import './NetworkSelector.css';

export const NetworkSelector: FC = () => {
    const { networks, networkId, network, selectNetwork } = useNetworkSelection();

    // By name, not by the id the backend orders by: someone looking for Köln should not have to
    // know it is filed under koeln. A native select stays usable at forty entries, so the order is
    // all this list needs.
    const sorted = useMemo(
        () => [...networks].sort((first, second) => first.name.localeCompare(second.name)),
        [networks]
    );

    if (networks.length < 2) return null;

    return (
        <section className="network-selector">
            <label htmlFor="network-select">Netz</label>
            <select
                id="network-select"
                value={networkId}
                onChange={(event) => selectNetwork(event.target.value)}
            >
                {sorted.map((option) => (
                    <option key={option.id} value={option.id}>
                        {option.status === 'beta' ? `${option.name} (Beta)` : option.name}
                    </option>
                ))}
            </select>
            {/* Which other cities the selected network covers. A native select has no search, so
                without this a rider in Dortmund cannot tell that the entry named Düsseldorf is the
                network their tram belongs to. */}
            {network !== undefined && network.serves.length > 0 && (
                <p className="network-serves-hint">Deckt außerdem ab: {network.serves.join(', ')}</p>
            )}
            {network?.status === 'beta' && (
                <p className="network-beta-hint">
                    {network.name} ist neu dabei. Hier siehst du nur echte Meldungen und noch keine
                    vorhergesagten, deshalb ist es leerer als gewohnt.
                </p>
            )}
        </section>
    );
};
