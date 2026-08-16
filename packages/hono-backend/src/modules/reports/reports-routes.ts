import { isNil } from 'lodash'
import { DateTime } from 'luxon'
import { z } from 'zod'

import { Env } from '../../app-env'
import { limitBodySize } from '../../common/body-limit'
import { AppError } from '../../common/errors'
import { defineRoute } from '../../common/router'
import { insertReportSchema } from '../../db'
import { networkQuerySchema, resolveNetworkId } from '../networks/types'

import { getDefaultReportsRange, MAX_REPORTS_TIMEFRAME } from './constants'

const NETWORK_PARAM_DESCRIPTION =
    'Network id from GET /v0/networks. Omitting it falls back to the default network so that ' +
    'clients released before multi network support keep working.'

const reportsQuerySchema = z
    .object({
        from: z.iso
            .datetime()
            .transform((str) => DateTime.fromISO(str))
            .optional(),
        to: z.iso
            .datetime()
            .transform((str) => DateTime.fromISO(str))
            .optional(),
    })
    .extend(networkQuerySchema.shape)
    .refine(({ to, from }) => {
        if (isNil(to) && isNil(from)) return true
        if (isNil(to) || isNil(from)) return false

        if (!from.isValid || !to.isValid) return false

        const range = to.diff(from)

        return range.toMillis() > 0 && range.as('days') <= MAX_REPORTS_TIMEFRAME
    })
    .transform((query) => {
        const networkId = resolveNetworkId(query)

        if (!isNil(query.from) && !isNil(query.to)) {
            return {
                networkId,
                from: query.from,
                to: query.to,
            }
        }

        return { networkId, ...getDefaultReportsRange(DateTime.now()) }
    })

const reportsQueryDocsSchema = z.object({
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    network: z.string().optional(),
})

export const getReports = defineRoute<Env>()({
    method: 'get',
    path: 'v0/reports',
    docs: {
        summary: 'List reports',
        description:
            'Returns reports of one network between an optional from/to ISO datetime range. ' +
            NETWORK_PARAM_DESCRIPTION,
        tags: ['reports'],
        querySchema: reportsQueryDocsSchema,
        responseSchema: z.array(
            z.object({
                timestamp: z.iso.datetime(),
                stationId: z.string(),
                directionId: z.string().nullable(),
                lineId: z.string().nullable(),
                isPredicted: z.boolean(),
            })
        ),
    },
    schemas: {
        query: reportsQuerySchema,
    },
    handler: async (c) => {
        const query = c.req.valid('query')
        const network = await c.get('networksService').require(query.networkId)

        return c.json(
            await c.get('reportsService').getReports({
                network,
                from: query.from!,
                to: query.to!,
                currentTime: DateTime.now(),
            })
        ) // Intentionally pass in local time
    },
})

export const getReportsByStation = defineRoute<Env>()({
    method: 'get',
    path: 'v0/reports/:stationId',
    docs: {
        summary: 'List reports by station',
        description:
            'Returns reports for a specific station between an optional from/to ISO datetime ' +
            'range. The station has to belong to the requested network, a station from another ' +
            `network is rejected with 422. ${NETWORK_PARAM_DESCRIPTION}`,
        tags: ['reports'],
        querySchema: reportsQueryDocsSchema,
        responseSchema: z.array(
            z.object({
                timestamp: z.iso.datetime(),
                stationId: z.string(),
                directionId: z.string().nullable(),
                lineId: z.string().nullable(),
                isPredicted: z.boolean(),
            })
        ),
    },
    schemas: {
        param: z.object({
            stationId: z.string().min(1),
        }),
        query: reportsQuerySchema,
    },
    handler: async (c) => {
        const query = c.req.valid('query')
        const { stationId } = c.req.valid('param')
        const network = await c.get('networksService').require(query.networkId)
        const reportsService = c.get('reportsService')

        /* Checked before reading, so that a station of another network is a 422 rather than an
           empty list that reads like "nothing reported here". */
        await reportsService.assertStationExistsInNetwork(stationId, network.id)

        return c.json(
            await reportsService.getReports({
                network,
                from: query.from!,
                to: query.to!,
                stationId,
                currentTime: DateTime.now(),
            })
        ) // Intentionally pass in local time
    },
})

export const postReport = defineRoute<Env>()({
    method: 'post',
    path: 'v0/reports',
    docs: {
        summary: 'Create a report',
        description:
            'Creates a report after anti-spam verification and post-processing. At least one of ' +
            'stationId, lineId, or directionId must be provided. The network scopes which stations ' +
            `and lines the post-processing may infer from, and the report is rejected if the ` +
            `reported station or line does not belong to it. ${NETWORK_PARAM_DESCRIPTION}`,
        tags: ['reports'],
        querySchema: networkQuerySchema,
        requestSchema: z.object({
            stationId: z.string().max(16).optional(),
            lineId: z.string().max(16).nullable().optional(),
            directionId: z.string().max(16).nullable().optional(),
            source: z.enum(['mini_app', 'web_app', 'mobile_app', 'telegram']).optional(),
        }),
        responseSchema: z.object({
            reportId: z.number().int(),
            stationId: z.string(),
            lineId: z.string().nullable(),
            directionId: z.string().nullable(),
            timestamp: z.iso.datetime(),
        }),
    },
    // A report is a handful of ids of at most 16 characters, so a kilobyte is already generous.
    middlewares: [limitBodySize(1024)],
    schemas: {
        query: networkQuerySchema,
        json: insertReportSchema,
    },
    handler: async (c) => {
        const reportsService = c.get('reportsService')
        const logger = c.get('logger')

        const networkId = resolveNetworkId(c.req.valid('query'))
        const network = await c.get('networksService').require(networkId)

        try {
            await reportsService.verifyRequest(c.req.header())
        } catch (err) {
            if (err instanceof AppError && err.internalCode === 'SPAM_REPORT_DETECTED') {
                logger.warn('Spam report blocked by security service')
                return c.json(
                    {
                        message: err.message,
                    },
                    err.statusCode
                )
            }
            logger.error(err, 'Error verifying request with security service')
            return c.json(
                {
                    message: 'Failed to verify request',
                },
                500
            )
        }

        const reportData = c.req.valid('json')

        /* The network is an input to the pipeline, not something we read off the report: it decides
           which stations and lines the inference rules are even allowed to consider. A station or
           line from another network is not silently corrected, it is dropped by the same rules that
           drop a station which is not on the reported line. */
        const postProcessedReportData = await reportsService.postProcessReport(
            {
                ...reportData,
                networkId,
                source: reportData.source ?? 'telegram',
            },
            network
        )

        const { telegramNotificationSuccess, report } = await reportsService.createReport({
            ...postProcessedReportData,
        })

        if (!telegramNotificationSuccess) {
            logger.error('Failed to notify Telegram bot about inspector report')
            c.header('X-Telegram-Notification-Status', 'failed')
        }

        return c.json(report)
    },
})
