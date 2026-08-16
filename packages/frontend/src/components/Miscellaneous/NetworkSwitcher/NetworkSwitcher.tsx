import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNetwork } from 'src/contexts/NetworkContext'
import { Network } from 'src/utils/types'

/**
 * Above this many networks the list stops being something you scan and starts being something you
 * search. Seven fits a settings panel without scrolling; the German deployment has more than forty.
 */
const FILTER_THRESHOLD = 7

/**
 * Lets a user look at another city than the one they are in. Hidden when the deployment serves a
 * single network, because then there is nothing to choose.
 */
const NetworkSwitcher: React.FC = () => {
    const { t } = useTranslation()
    const { networks, network, selectNetwork } = useNetwork()
    const [filter, setFilter] = useState('')

    // Sorted by name rather than by the order the backend returns, which is by id: a reader looking
    // for "Köln" should not have to know it is filed under "koeln".
    const sorted = useMemo(
        () => [...networks].sort((first, second) => first.name.localeCompare(second.name)),
        [networks]
    )

    const query = filter.trim().toLocaleLowerCase()

    /**
     * The city that made a network match, when it was not the network's own name.
     *
     * A network is named after one city and often serves a dozen. Someone in Dortmund searching
     * for their city would otherwise be told that no network matches, while the Rhine-Ruhr network
     * that stops at Dortmund Hauptbahnhof sits in the list two rows up under Düsseldorf. Naming the
     * city that matched is what makes the result make sense instead of looking like a bug.
     */
    const matchedCity = (candidate: Network): string | undefined =>
        candidate.name.toLocaleLowerCase().includes(query)
            ? undefined
            : candidate.serves.find((city) => city.toLocaleLowerCase().includes(query))

    const matches = (candidate: Network) =>
        candidate.name.toLocaleLowerCase().includes(query) || matchedCity(candidate) !== undefined

    const visible = query === '' ? sorted : sorted.filter(matches)

    if (networks.length <= 1) return null

    return (
        <div className="flex w-full flex-col gap-1">
            <div className="separator" />
            <span className="toggle-switch__label">{t('Network.title')}</span>
            {networks.length > FILTER_THRESHOLD ? (
                <input
                    type="search"
                    className="rounded-sm border border-gray-500 bg-transparent px-2 py-1 text-xs"
                    placeholder={t('Network.filterPlaceholder')}
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    aria-label={t('Network.filterPlaceholder')}
                />
            ) : null}
            <div className="flex flex-wrap gap-2">
                {visible.map((candidate) => (
                    <button
                        key={candidate.id}
                        type="button"
                        className={`flex items-center gap-1 rounded-sm border px-2 py-1 text-xs ${
                            candidate.id === network?.id ? 'border-[var(--incentive-blue)]' : 'border-gray-500'
                        }`}
                        onClick={() => selectNetwork(candidate.id)}
                    >
                        {candidate.name}
                        {matchedCity(candidate) !== undefined ? (
                            <span className="text-[10px] opacity-70">{matchedCity(candidate)}</span>
                        ) : null}
                        {candidate.status === 'beta' ? (
                            <span className="rounded-sm bg-gray-600 px-1 text-[10px] uppercase">
                                {t('Network.beta')}
                            </span>
                        ) : null}
                    </button>
                ))}
            </div>
            {visible.length === 0 ? <p className="text-xs">{t('Network.noMatch', { query: filter.trim() })}</p> : null}
            {network !== null && network.serves.length > 0 ? (
                <p className="text-xs opacity-70">
                    {t('Network.alsoServes', { cities: network.serves.join(', ') })}
                </p>
            ) : null}
            {network?.status === 'beta' ? (
                <p className="text-xs">{t('Network.betaDescription', { network: network.name })}</p>
            ) : null}
        </div>
    )
}

export { NetworkSwitcher }
