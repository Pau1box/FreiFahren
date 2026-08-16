export const filterNullish = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined

/**
 * Station names arrive with the operator's mode marker in front of them ("S Ostkreuz"). Nobody types
 * it, so it only hurts the fuzzy match. A single character followed by a space is the marker's shape
 * in the source data rather than a particular city's letters, which is why this is not a letter list.
 */
export const stripModeMarker = (name: string): string => name.replace(/^\S\s+/, '')
