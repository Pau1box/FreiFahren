import { bodyLimit } from 'hono/body-limit'

/**
 * Caps the request body of a writing route.
 *
 * The endpoints are public and unauthenticated, so without a cap a single request can make the
 * process buffer as much as the client cares to send. The limit is set per route rather than
 * globally, because the sensible size for a report of two short ids and for a free text feedback
 * message are two orders of magnitude apart, and the tighter one is the one worth having.
 *
 * The response is JSON rather than the middleware's default plain text, so a client sees the same
 * error shape here as everywhere else.
 */
export const limitBodySize = (maxSize: number) =>
    bodyLimit({
        maxSize,
        onError: (c) =>
            c.json(
                {
                    message: 'Request body too large',
                    details: {
                        internal_code: 'VALIDATION_FAILED',
                        description: `The body of this request may not exceed ${maxSize} bytes.`,
                    },
                },
                413
            ),
    })
