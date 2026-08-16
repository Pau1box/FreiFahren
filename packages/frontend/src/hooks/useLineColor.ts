import { useCallback } from 'react'
import { useLineMetadata } from 'src/api/queries'
import { NEUTRAL_LINE_COLOR } from 'src/utils/lineModes'

/**
 * Line colours come from the network's metadata. A line the metadata does not know is drawn
 * neutrally rather than in a colour borrowed from another city.
 */
export const useLineColor = (): ((line: string) => string) => {
    const { data: lineMetadata } = useLineMetadata()

    return useCallback((line: string) => lineMetadata?.[line]?.color ?? NEUTRAL_LINE_COLOR, [lineMetadata])
}
