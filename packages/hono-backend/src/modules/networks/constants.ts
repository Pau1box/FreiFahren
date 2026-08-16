/**
 * The network a request falls back to when it does not name one.
 *
 * This exists purely for backwards compatibility. Every client that shipped before multi network
 * support calls `/v0/transit/stations` and `/v0/reports` without a network parameter and expects
 * Berlin, so that is what they keep getting. New clients always send the parameter explicitly.
 */
export const DEFAULT_NETWORK_ID = 'berlin'
