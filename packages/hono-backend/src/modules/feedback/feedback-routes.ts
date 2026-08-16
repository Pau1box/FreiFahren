import { z } from 'zod'

import { Env } from '../../app-env'
import { limitBodySize } from '../../common/body-limit'
import { defineRoute } from '../../common/router'
import { db, feedback, insertFeedbackSchema } from '../../db'

export const postFeedback = defineRoute<Env>()({
    method: 'post',
    path: 'v0/feedback',
    docs: {
        summary: 'Submit feedback',
        description: 'Stores a user feedback message for the team to review.',
        tags: ['feedback'],
        requestSchema: z.object({
            feedback: z.string(),
        }),
    },
    // Free text, so a larger cap than a report, but still far below "as much as you like".
    middlewares: [limitBodySize(4096)],
    schemas: {
        json: insertFeedbackSchema,
    },
    handler: async (c) => {
        const { feedback: feedbackText } = c.req.valid('json')
        // Truncated to the column width: a long User-Agent is a client's business, not a 500 of ours.
        const userAgent = c.req.header('user-agent')?.slice(0, 512) ?? null

        await db.insert(feedback).values({ feedback: feedbackText, userAgent })

        return c.body(null, 201)
    },
})
