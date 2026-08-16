import React from 'react'
import { useTranslation } from 'react-i18next'
import { useNetwork } from 'src/contexts/NetworkContext'

/**
 * A beta network never serves predicted reports, so its map is emptier than an established one.
 * Saying that on the map itself is the difference between "nothing is happening here" and "we do not
 * know yet".
 */
const NetworkBetaNotice: React.FC = () => {
    const { t } = useTranslation()
    const { network } = useNetwork()

    if (network === null || network.status !== 'beta') return null

    return (
        // below the utility button, which sits at the same edge
        <div className="bg-background fixed left-[15px] top-[145px] z-0 max-w-[220px] rounded-2xl border-2 border-black p-2 text-left shadow-xl">
            <p className="text-xs font-bold">
                {network.name} <span className="uppercase">{t('Network.beta')}</span>
            </p>
            <p className="text-[10px]">{t('Network.betaDescription', { network: network.name })}</p>
        </div>
    )
}

export { NetworkBetaNotice }
