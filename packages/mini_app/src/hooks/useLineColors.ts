import { useCallback, useMemo } from 'react'
import { useLineMetadata } from '../api/queries'
import { MODE_ORDER, NEUTRAL_LINE_COLOR } from '../utils/lines'
import type { LineMode } from '../utils/types'

/** Line colours come from the network's metadata instead of a table per city inside the client. */
export const useLineColor = (): ((line: string | null | undefined) => string) => {
    const { data: metadata } = useLineMetadata()

    return useCallback(
        (line) => (line === null || line === undefined ? undefined : metadata?.[line]?.color) ?? NEUTRAL_LINE_COLOR,
        [metadata]
    )
}

export const useLineMode = (): ((line: string) => LineMode) => {
    const { data: metadata } = useLineMetadata()

    return useCallback((line) => metadata?.[line]?.mode ?? 'unknown', [metadata])
}

/**
 * The modes that actually run in the active network, each with a colour taken from one of its lines.
 * A city without an underground shows no underground filter.
 */
export const useAvailableModes = (): { mode: LineMode; color: string }[] => {
    const { data: metadata } = useLineMetadata()

    return useMemo(() => {
        const colorByMode = new Map<LineMode, string>()

        Object.values(metadata ?? {}).forEach(({ mode, color }) => {
            if (!colorByMode.has(mode)) colorByMode.set(mode, color)
        })

        return MODE_ORDER.filter((mode) => colorByMode.has(mode)).map((mode) => ({
            mode,
            color: colorByMode.get(mode) ?? NEUTRAL_LINE_COLOR,
        }))
    }, [metadata])
}
