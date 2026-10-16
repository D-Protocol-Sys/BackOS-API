import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prismamodels/client';

/**
 * Standardized structure for HTTP error responses returned to the client.
 */
interface ErrorResponseBody {
    statusCode: number;
    message: string | string[];
    error: string;
    timestamp: string;
    path: string;
}

/**
 * Global Exception Filter.
 * * `@Catch()` with no arguments acts as a catch-all filter, intercepting ALL unhandled
 * exceptions (HttpExceptions, ORM/Prisma errors, unhandled JS Errors) across the API.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
    // Instantiates NestJS logger dedicated to exception reporting
    private readonly logger = new Logger('ExceptionFilter');

    /**
     * Main filter entry point invoked automatically by NestJS whenever an exception is thrown.
     * * @param exception - The raw unhandled error or exception object.
     * @param host - Execution context helper providing access to HTTP request/response objects.
     */
    catch(exception: unknown, host: ArgumentsHost) {
        // Extract HTTP context to access underlying Express request & response objects
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request>();

        // Map and normalize any thrown error into a standardized format
        const { statusCode, message, error } = this.resolveException(exception);

        // Dynamic logging strategy based on severity level
        if (statusCode >= 500) {
            // Server errors (5xx): Log as severe errors with full stack trace for debugging
            this.logger.error(
                `${request.method} ${request.url} -> ${statusCode}`,
                exception instanceof Error ? exception.stack : String(exception),
            );
        } else {
            // Client errors (4xx): Log as warnings with simplified message payloads
            this.logger.warn(`${request.method} ${request.url} -> ${statusCode} : ${JSON.stringify(message)}`);
        }

        // Construct unified HTTP JSON response body
        const body: ErrorResponseBody = {
            statusCode,
            message,
            error,
            timestamp: new Date().toISOString(),
            path: request.url,
        };

        // Send HTTP response with appropriate status code and formatted payload
        response.status(statusCode).json(body);
    }

    /**
     * Helper method that normalizes various types of exceptions into a unified tuple format.
     * * @param exception - The unknown caught exception.
     * @returns An object containing normalized statusCode, user message, and error title.
     */
    private resolveException(exception: unknown): {
        statusCode: number;
        message: string | string[];
        error: string;
    } {
        // 1. Handle standard NestJS HTTP exceptions (e.g., BadRequestException, UnauthorizedException)
        if (exception instanceof HttpException) {
            const status = exception.getStatus();
            const res = exception.getResponse();

            if (typeof res === 'string') {
                return { statusCode: status, message: res, error: exception.name };
            }

            const resObj = res as { message?: string | string[]; error?: string };
            return {
                statusCode: status,
                message: resObj.message ?? exception.message,
                error: resObj.error ?? exception.name,
            };
        }

        // 2. Handle known Database/Prisma errors and convert them to user-friendly HTTP statuses
        if (exception instanceof Prisma.PrismaClientKnownRequestError) {
            switch (exception.code) {
                case 'P2002': // Unique constraint violation (e.g., duplicate email)
                    return {
                        statusCode: HttpStatus.CONFLICT,
                        message: 'A resource with this unique value already exists.',
                        error: 'Conflict',
                    };
                case 'P2025': // Record to update/delete not found
                    return {
                        statusCode: HttpStatus.NOT_FOUND,
                        message: 'Resource not found.',
                        error: 'Not Found',
                    };
                case 'P2003': // Foreign key constraint failed
                    return {
                        statusCode: HttpStatus.CONFLICT,
                        message: 'Action failed: relational constraint error with another resource.',
                        error: 'Conflict',
                    };
                default: // Fallback for unhandled database error codes
                    return {
                        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
                        message: 'A database error occurred.',
                        error: 'Internal Server Error',
                    };
            }
        }

        // 3. Ultimate fallback for unhandled standard JS runtime errors (500 Internal Server Error)
        return {
            statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
            message: 'An internal server error occurred.',
            error: 'Internal Server Error',
        };
    }
}
