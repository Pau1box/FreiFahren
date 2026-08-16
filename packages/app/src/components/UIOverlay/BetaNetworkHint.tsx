import { useTranslation } from 'react-i18next'

import { useActiveNetwork } from '../../networks'
import { FFText } from '../common/base'
import { FFBox } from '../common/FFBox'

/**
 * A beta network only shows reports people actually made, so its map is emptier than the one users
 * know. Saying so beats letting them conclude that nothing is happening.
 */
export const BetaNetworkHint = () => {
    const { t } = useTranslation('networks')
    const network = useActiveNetwork()

    if (network?.status !== 'beta') return null

    return (
        <FFBox mt="xxs" py="xxs">
            <FFText variant="labelSmall">{t('betaBadge')}</FFText>
            <FFText variant="small" mt="xxxs">
                {t('betaExplanation', { network: network.name })}
            </FFText>
        </FFBox>
    )
}
