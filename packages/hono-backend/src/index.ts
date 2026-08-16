import { Hono } from 'hono'
import { etag } from 'hono/etag'
import { requestId } from 'hono/request-id'
import { pinoLogger } from 'hono-pino'
import pino from 'pino'

import { registerServices, Services, type Env } from './app-env'
import { handleError } from './common/error-handler'
import { registerDocsRoutes } from './common/openapi'
import { registerRoutes } from './common/router'
import { db, DbConnection } from './db'
import { postFeedback } from './modules/feedback/feedback-routes'
import { getNetworks, NetworksService } from './modules/networks'
import { getReports, getReportsByStation, postReport, ReportsService } from './modules/reports/'
import { TransitNetworkDataService } from './modules/transit/transit-network-data-service'
import { getLineMetadata, getLines, getStations } from './modules/transit/transit-routes'

const app = new Hono<Env>()

app.use(requestId())
app.use(
    pinoLogger({
        pino: pino({
            level: process.env.LOG_LEVEL ?? 'info',
            transport: {
                targets: [
                    {
                        target: 'pino-pretty',
                        options: {
                            colorize: true,
                            ignore: 'pid,hostname,req,res,responseTime,reqId',
                            translateTime: 'SYS:standard',
                            destination: 1,
                        },
                    },
                    {
                        target: 'pino-roll',
                        options: {
                            file: './app.log',
                            frequency: 'daily',
                            mkdir: true,
                        },
                    },
                ],
            },
        }),
    })
)

/* The station and line graph is the largest thing we serve and changes only when a seed runs, while
   a client fetches it on every start. Revalidation by ETag turns that into a 304 for as long as the
   data is unchanged. `must-revalidate` rather than a max age because a re-seed has to reach clients
   immediately, and the conditional request is cheap enough that it does not need to be skipped.
   The Go backend caches the same responses per network, see packages/backend/caching. */
app.use('/v0/transit/*', etag(), async (c, next) => {
    await next()
    c.header('Cache-Control', 'public, max-age=0, must-revalidate')
})

app.onError(handleError)

const createServices = (db: DbConnection) => {
    const networksService = new NetworksService(db)
    const transitNetworkDataService = new TransitNetworkDataService(db)

    const reportsService = new ReportsService(db, transitNetworkDataService)

    return { networksService, transitNetworkDataService, reportsService } satisfies Services
}

registerServices(app, createServices(db))

/* `lines/metadata` is registered before `lines` so the static path is never swallowed by a route
   that treats the trailing segment as a line id. */
const routes = [
    getNetworks,
    getReports,
    getReportsByStation,
    postReport,
    getStations,
    getLineMetadata,
    getLines,
    postFeedback,
] as const

registerRoutes(app, [...routes])
registerDocsRoutes(app, [...routes])

export { app }

export default {
    fetch: app.fetch,
    port: 3000,
    hostname: '0.0.0.0',
}
