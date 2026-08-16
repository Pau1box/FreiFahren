import { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { ContentfulStatusCode } from 'hono/utils/http-status'

import { AppError } from './errors'

export const handleError = (err: Error, c: Context) => {
    /* Hono's own middleware signals a bad request by throwing this, for example when the body is not
       parsable as JSON or exceeds the body limit. Without this branch its status is lost and the
       caller is told the server broke when it was the request that did. */
    if (err instanceof HTTPException) {
        c.get('logger').warn({ statusCode: err.status }, err.message)
        return c.json(
            {
                message: err.message,
                details: {
                    internal_code: 'VALIDATION_FAILED',
                },
            },
            err.status
        )
    }

    if (err instanceof AppError) {
        c.get('logger').error(
            {
                internal_code: err.internalCode,
                statusCode: err.statusCode,
                description: err.description,
                internal_details: err.internalDetails,
            },
            err.message
        )
        return c.json(
            {
                message: err.message,
                details: {
                    internal_code: err.internalCode,
                    description: err.description,
                },
            },
            err.statusCode
        )
    }

    c.get('logger').error(err, 'Unhandled error')
    return c.json(
        {
            message: 'Internal Server Error',
            details: {
                internal_code: 'UNKNOWN_ERROR',
                description: process.env.NODE_ENV === 'production' ? undefined : err.message,
            },
        },
        500 as ContentfulStatusCode
    )
}
