import './StatsPopUp.css'

import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNetwork } from 'src/contexts/NetworkContext'

interface StatsPopUpProps {
    className: string
    numberOfReports: number
    openListModal: () => void
    numberOfUsers: number
}

const StatsPopUp: React.FC<StatsPopUpProps> = ({ className, numberOfReports, openListModal, numberOfUsers }) => {
    const { t } = useTranslation()
    const { network } = useNetwork()
    /*
     The message is rendered as raw HTML below and i18next escaping is off globally, so the one
     value that comes from the API is escaped explicitly here.
    */
    const networkName = network?.name ?? ''
    const escaping = { interpolation: { escapeValue: true } }
    /*
     Which of the two messages is showing, rather than the rendered message itself. Holding the
     finished HTML in state froze the network name at mount, so switching the city while the popup
     was still up left the previous city's name standing.
    */
    const [showsReporters, setShowsReporters] = useState(false)
    const message = showsReporters
        ? `<p class="text-center">${t('StatsPopUp.over')} <strong> ${numberOfUsers} ${t('StatsPopUp.reporters')}</strong><br /> ${t('StatsPopUp.inNetwork', { network: networkName, ...escaping })}</p>`
        : `<p class="text-center"><strong>${numberOfReports} ${t('StatsPopUp.reports')}</strong><br /> ${t('StatsPopUp.todayInNetwork', { network: networkName, ...escaping })}</p>`
    const [popOut, setPopOut] = useState(false)
    const [isVisible, setIsVisible] = useState(true)

    const timeForOneMessage = 3.5 * 1000
    const timeForPopOutAnimation = 0.5 * 1000

    const hidePopupAfterAnimation = useCallback(() => {
        setTimeout(() => {
            setPopOut(false)
            setTimeout(() => setIsVisible(false), timeForOneMessage)
        }, timeForPopOutAnimation)
    }, [timeForOneMessage, timeForPopOutAnimation])

    useEffect(() => {
        const timer = setTimeout(() => {
            setShowsReporters(true)
            setPopOut(true)
            hidePopupAfterAnimation()
        }, timeForOneMessage)

        return () => clearTimeout(timer)
    }, [hidePopupAfterAnimation, timeForOneMessage])

    // eslint-disable-next-line consistent-return
    useEffect(() => {
        if (popOut) {
            const timer = setTimeout(() => setPopOut(false), timeForPopOutAnimation)

            return () => clearTimeout(timer)
        }
    }, [popOut, timeForPopOutAnimation])

    return (
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
        <div
            className={`stats-popup center-child h-fit ${className} ${popOut ? 'pop-out' : ''} ${!isVisible ? 'fade-out' : ''}`}
            // eslint-disable-next-line react/jsx-handler-names
            onClick={openListModal}
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: message }}
        />
    )
}

export { StatsPopUp }
