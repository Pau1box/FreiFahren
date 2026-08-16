import { ComponentProps, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { Network } from '../../api/client'
import { useNetworkSelection } from '../../networks'
import { track } from '../../tracking'
import { FFText, FFView } from './base'
import { FFCarousellSelect } from './FFCarousellSelect'

export const NetworkSwitcher = (props: ComponentProps<typeof FFView>) => {
    const { t } = useTranslation('networks')
    const { networks, activeNetwork, selectNetwork } = useNetworkSelection()

    // The backend returns networks by id, so Cologne would sit under "koeln" and Munich under
    // "munich". Scrolling a carousel of more than forty of them is hard enough without that.
    const sorted = useMemo(
        () => [...networks].sort((first, second) => first.name.localeCompare(second.name)),
        [networks]
    )

    if (networks.length < 2) return null

    const handleSelect = (network: Network) => {
        track({ name: 'Network Switched', network: network.id })
        selectNetwork(network.id)
    }

    return (
        <FFView {...props}>
            <FFCarousellSelect
                hideCheck
                options={sorted}
                selectedOption={sorted.find(({ id }) => id === activeNetwork?.id) ?? null}
                onSelect={handleSelect}
                renderOption={(network: Network) => (
                    <FFView flexDirection="row" alignItems="center" gap="xxs">
                        <FFText variant="label">{network.name}</FFText>
                        {network.status === 'beta' && (
                            <FFView bg="darkGrey" borderRadius="s" px="xxxs">
                                <FFText variant="tiny">{t('betaBadge')}</FFText>
                            </FFView>
                        )}
                    </FFView>
                )}
            />
            {/* Which other cities the selected network covers. The carousel has no search field,
                so this is what tells a rider in Dortmund that the network filed under Düsseldorf is
                theirs rather than a neighbouring city's. */}
            {activeNetwork !== undefined && activeNetwork.serves.length > 0 && (
                <FFText variant="small" mt="xxs" color="fg">
                    {t('alsoServes', { cities: activeNetwork.serves.join(', ') })}
                </FFText>
            )}
            {activeNetwork?.status === 'beta' && (
                <FFText variant="small" mt="xxs">
                    {t('betaExplanation', { network: activeNetwork.name })}
                </FFText>
            )}
        </FFView>
    )
}
