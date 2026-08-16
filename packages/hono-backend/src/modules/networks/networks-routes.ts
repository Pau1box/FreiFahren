import { z } from 'zod'

import { Env } from '../../app-env'
import { defineRoute } from '../../common/router'

import type { Network } from './types'

const networkResponseSchema = z.object({
    id: z.string(),
    name: z.string(),
    countryCode: z.string(),
    timezone: z.string(),
    center: z.object({
        latitude: z.number(),
        longitude: z.number(),
    }),
    bounds: z.object({
        southWest: z.object({ latitude: z.number(), longitude: z.number() }),
        northEast: z.object({ latitude: z.number(), longitude: z.number() }),
    }),
    status: z.enum(['active', 'beta']),
    serves: z.array(z.string()),
})

/**
 * Nests the flat database columns into the shape clients actually use, mirroring how stations
 * already expose `coordinates`. A client can hand `bounds` straight to a map component.
 */
const toResponse = (network: Network): z.infer<typeof networkResponseSchema> => ({
    id: network.id,
    name: network.name,
    countryCode: network.countryCode,
    timezone: network.timezone,
    center: { latitude: network.centerLat, longitude: network.centerLng },
    bounds: {
        southWest: { latitude: network.boundsSwLat, longitude: network.boundsSwLng },
        northEast: { latitude: network.boundsNeLat, longitude: network.boundsNeLng },
    },
    status: network.status,
    serves: network.serves,
})

export const getNetworks = defineRoute<Env>()({
    method: 'get' as const,
    path: 'v0/networks',
    docs: {
        summary: 'List networks',
        description:
            'Returns every transit network this deployment serves, with the geography a client ' +
            'needs to position its map. Use the `id` as the `network` query parameter on the ' +
            'transit and reports endpoints. A `beta` network has thin coverage, so clients should ' +
            'say so rather than presenting an empty map as if nothing were happening. `serves` ' +
            'lists the other cities a network reaches, so a client can let a rider find the ' +
            'Rhine-Ruhr network by searching for Dortmund.',
        tags: ['networks'],
        responseSchema: z.array(networkResponseSchema),
    },
    handler: async (c) => {
        const networksService = c.get('networksService')
        const allNetworks = await networksService.list()

        return c.json(allNetworks.map(toResponse))
    },
})
