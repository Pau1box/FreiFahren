import { useTheme } from '@shopify/restyle'
import { useCallback, useMemo } from 'react'

import { LineMode } from './api/client'
import { useLinesMetadata } from './api/queries'
import { Theme } from './theme'

/** The order the modes are offered in. Rail first, street level after, unclassified last. */
const MODE_ORDER: LineMode[] = ['subway', 'light_rail', 'tram', 'train', 'unknown']

export const useLineColor = () => {
    const { data: metadata } = useLinesMetadata()
    const { colors } = useTheme<Theme>()

    return useCallback(
        (line: string | null | undefined) =>
            (line === null || line === undefined ? undefined : metadata?.[line]?.color) ?? colors.lineNeutral,
        [metadata, colors.lineNeutral]
    )
}

export const useLineMode = () => {
    const { data: metadata } = useLinesMetadata()

    return useCallback((line: string): LineMode => metadata?.[line]?.mode ?? 'unknown', [metadata])
}

/** The modes that actually run in the active network. A city without a tram offers no tram filter. */
export const useAvailableModes = (): LineMode[] => {
    const { data: metadata } = useLinesMetadata()

    return useMemo(() => {
        const present = new Set(Object.values(metadata ?? {}).map(({ mode }) => mode))

        return MODE_ORDER.filter((mode) => present.has(mode))
    }, [metadata])
}

/**
 * A ring has no terminus, so a report on one carries no meaningful direction. Which lines run in a
 * loop is a property of the network and comes from its metadata, never from a list of line names.
 */
export const useIsRingLine = () => {
    const { data: metadata } = useLinesMetadata()

    return useCallback((line: string): boolean => metadata?.[line]?.isCircular ?? false, [metadata])
}

/** Numeric comparison so that S10 sorts after S2 rather than after S1. */
export const compareLineNames = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })
