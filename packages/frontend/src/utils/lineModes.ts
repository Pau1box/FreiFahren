import { LineMetadataList, LineMode } from './types'

/**
 * The one place that ranks modes. Sorting by mode instead of by line name is what keeps the client
 * working in a city whose lines are not called U or S. The order follows how prominent a mode
 * usually is on a network map: the underground carries the most people, buses and unnamed lines the
 * fewest.
 */
export const LINE_MODE_ORDER: readonly LineMode[] = ['subway', 'light_rail', 'train', 'tram', 'unknown']

/** Rendered for a line the network has no metadata for, so an unknown line never borrows a colour. */
export const NEUTRAL_LINE_COLOR = '#6b7280'

export const lineModeRank = (mode: LineMode | undefined): number => {
    const rank = LINE_MODE_ORDER.indexOf(mode ?? 'unknown')

    return rank === -1 ? LINE_MODE_ORDER.length : rank
}

/** Modes that actually occur in the given network, most prominent first. */
export const modesInNetwork = (metadata: LineMetadataList): LineMode[] => {
    const modes = new Set(Object.values(metadata).map((line) => line.mode))

    return LINE_MODE_ORDER.filter((mode) => modes.has(mode))
}

/**
 * An index signature does not express a missing key, so lookups widen to undefined here rather than
 * pretending every line has metadata.
 */
export const lineModeOf = (metadata: Partial<LineMetadataList>, line: string): LineMode | undefined =>
    metadata[line]?.mode

/**
 * A ring has no terminus, so a report on one carries no meaningful direction. Which lines run in a
 * loop is a property of the network and comes from its metadata, never from a list of line names.
 */
export const isRingLine = (metadata: Partial<LineMetadataList>, line: string): boolean =>
    metadata[line]?.isCircular ?? false

/**
 * Groups lines by mode and sorts naturally inside a group, so S2 comes before S10 rather than after
 * it.
 */
export const compareLines = (a: string, b: string, metadata: LineMetadataList): number => {
    const rankDifference = lineModeRank(lineModeOf(metadata, a)) - lineModeRank(lineModeOf(metadata, b))

    if (rankDifference !== 0) {
        return rankDifference
    }

    return a.localeCompare(b, undefined, { numeric: true })
}
