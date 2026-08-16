import { asc, eq } from 'drizzle-orm'

import { AppError } from '../../common/errors'
import { DbConnection, networks } from '../../db'

import type { Network, NetworkId } from './types'

/**
 * Reads the list of networks a deployment serves.
 *
 * Deliberately uncached, unlike the station and line graph. The table holds one row per city, so
 * the query is trivial, and caching it would mean a network added by a seed stays invisible until
 * the process restarts.
 */
export class NetworksService {
    constructor(private db: DbConnection) {}

    async list(): Promise<Network[]> {
        return this.db.select().from(networks).orderBy(asc(networks.id))
    }

    async find(networkId: NetworkId): Promise<Network | undefined> {
        const [network] = await this.db.select().from(networks).where(eq(networks.id, networkId)).limit(1)
        return network
    }

    /**
     * Resolves a network or fails the request. Used by every route that takes a `network` query
     * parameter, so that a typo produces a clear 404 instead of a silently empty map.
     */
    async require(networkId: NetworkId): Promise<Network> {
        const network = await this.find(networkId)

        if (network === undefined) {
            throw new AppError({
                message: `Unknown network '${networkId}'. Call GET /v0/networks for the list of available networks.`,
                statusCode: 404,
                internalCode: 'NETWORK_NOT_FOUND',
            })
        }

        return network
    }
}
