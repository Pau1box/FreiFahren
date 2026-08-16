import type { LineMetadataList, LineMode } from './types'

/** The order the modes are offered in. Rail first, street level after, unclassified last. */
export const MODE_ORDER: LineMode[] = ['subway', 'light_rail', 'tram', 'train', 'unknown']

/** German names for the modes. The mini app is single language, like the rest of its texts. */
export const MODE_LABELS: Record<LineMode, string> = {
    subway: 'U-Bahn',
    light_rail: 'S-Bahn',
    tram: 'Tram',
    train: 'Zug',
    unknown: 'Sonstige',
}

/** A line without a colour of its own is drawn neutrally rather than guessed at. */
export const NEUTRAL_LINE_COLOR = '#6f6f6f'

/**
 * A ring has no terminus, so a report on one carries no meaningful direction. Which lines run in a
 * loop is a property of the network and comes from its metadata, never from a list of line names.
 */
export const isRingLine = (metadata: LineMetadataList | undefined, line: string): boolean =>
    metadata?.[line]?.isCircular ?? false

/** Numeric comparison so that S10 sorts after S2 rather than after S1. */
export const compareLineNames = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true })

/**
 * Station names arrive with the operator's mode marker in front of them ("S Ostkreuz"). Nobody types
 * it, so it only hurts the fuzzy match. A single character followed by a space is the marker's shape
 * in the source data rather than a particular city's letters, which is why this is not a letter list.
 */
export const stripModeMarker = (name: string): string => name.replace(/^\S\s+/, '')
