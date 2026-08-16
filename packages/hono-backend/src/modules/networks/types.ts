import { InferSelectModel } from 'drizzle-orm'
import { z } from 'zod'

import { networks } from '../../db/schema/networks'

import { DEFAULT_NETWORK_ID } from './constants'

type Network = InferSelectModel<typeof networks>
type NetworkId = Network['id']

/**
 * The `?network=` query parameter that scopes a request to one transit system.
 *
 * It is optional on purpose. Clients that shipped before multi network support do not send it and
 * must keep working, so an absent parameter means the default network rather than an error.
 */
const networkQuerySchema = z.object({
    network: z.string().min(1).max(32).optional(),
})

const resolveNetworkId = (query: z.infer<typeof networkQuerySchema>): NetworkId => query.network ?? DEFAULT_NETWORK_ID

export { networkQuerySchema, resolveNetworkId }
export type { Network, NetworkId }
