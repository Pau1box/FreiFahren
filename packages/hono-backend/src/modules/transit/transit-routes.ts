import { z } from 'zod'

import { Env } from '../../app-env'
import { defineRoute } from '../../common/router'
import { networkQuerySchema, resolveNetworkId } from '../networks/types'

const NETWORK_PARAM_DESCRIPTION =
    'Network id from GET /v0/networks. Omitting it falls back to the default network so that ' +
    'clients released before multi network support keep working.'

export const getStations = defineRoute<Env>()({
    method: 'get' as const,
    path: 'v0/transit/stations',
    docs: {
        summary: 'List stations',
        description: `Returns all transit stations of one network. ${NETWORK_PARAM_DESCRIPTION}`,
        tags: ['transit'],
        querySchema: networkQuerySchema,
        responseSchema: z.record(
            z.string(),
            z.object({
                name: z.string(),
                coordinates: z.object({
                    latitude: z.number(),
                    longitude: z.number(),
                }),
                lines: z.array(z.string()),
            })
        ),
    },
    schemas: {
        query: networkQuerySchema,
    },
    handler: async (c) => {
        const networkId = resolveNetworkId(c.req.valid('query'))
        await c.get('networksService').require(networkId)

        return c.json(await c.get('transitNetworkDataService').getStations(networkId))
    },
})

export const getLineMetadata = defineRoute<Env>()({
    method: 'get' as const,
    path: 'v0/transit/lines/metadata',
    docs: {
        summary: 'Line colours and modes',
        description:
            'How to render each line of a network. Clients used to carry this per city in code, ' +
            'as a table of Berlin line names, which is why it is served as data instead. ' +
            `'mode' is 'unknown' when OpenStreetMap has no route relation for the line; render it ` +
            `neutrally rather than guessing. ${NETWORK_PARAM_DESCRIPTION}`,
        tags: ['transit'],
        querySchema: networkQuerySchema,
        responseSchema: z.record(
            z.string(),
            z.object({
                color: z.string(),
                mode: z.enum(['subway', 'light_rail', 'tram', 'train', 'unknown']),
                isCircular: z.boolean(),
            })
        ),
    },
    schemas: {
        query: networkQuerySchema,
    },
    handler: async (c) => {
        const networkId = resolveNetworkId(c.req.valid('query'))
        await c.get('networksService').require(networkId)

        return c.json(await c.get('transitNetworkDataService').getLineMetadata(networkId))
    },
})

export const getLines = defineRoute<Env>()({
    method: 'get' as const,
    path: 'v0/transit/lines',
    docs: {
        summary: 'List lines',
        description:
            'Returns all transit lines of one network, each with its stations in travel order. ' +
            `Line ids are only unique within a network: 'S1' exists in several German cities. ` +
            NETWORK_PARAM_DESCRIPTION,
        tags: ['transit'],
        querySchema: networkQuerySchema,
        responseSchema: z.record(z.string(), z.array(z.string())),
    },
    schemas: {
        query: networkQuerySchema,
    },
    handler: async (c) => {
        const networkId = resolveNetworkId(c.req.valid('query'))
        await c.get('networksService').require(networkId)

        return c.json(await c.get('transitNetworkDataService').getLines(networkId))
    },
})
