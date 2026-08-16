import { ContentfulStatusCode } from 'hono/utils/http-status'

export type InternalCode =
    | 'TELEGRAM_NOTIFICATION_FAILED'
    | 'UNKNOWN_ERROR'
    | 'SPAM_REPORT_DETECTED'
    | 'VALIDATION_FAILED'
    | 'NETWORK_NOT_FOUND'

export interface AppErrorDetails {
    internal_code: InternalCode
    description?: string
}

export interface AppErrorOptions {
    message: string
    statusCode?: ContentfulStatusCode
    internalCode?: InternalCode
    description?: string
    /**
     * Diagnostic context for the log only, never part of the response body.
     *
     * `description` is echoed to the client, so anything that would hand a caller our internals,
     * such as the raw request payload or an intermediate state of the processing pipeline, belongs
     * here instead.
     */
    internalDetails?: unknown
}

export class AppError extends Error {
    public readonly statusCode: ContentfulStatusCode
    public readonly internalCode: InternalCode
    public readonly description?: string
    public readonly internalDetails?: unknown

    constructor({
        message,
        statusCode = 500,
        internalCode = 'UNKNOWN_ERROR',
        description,
        internalDetails,
    }: AppErrorOptions) {
        super(message)
        this.name = 'AppError'
        this.statusCode = statusCode
        this.internalCode = internalCode
        this.description = description
        this.internalDetails = internalDetails
    }
}
