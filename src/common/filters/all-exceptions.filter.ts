import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prismamodels/client';

interface ErrorResponseBody {
    statusCode: number;
    message: string | string[];
    error: string;
    timestamp: string;
    path: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {

    private readonly logger = new Logger('ExceptionFilter');

    catch(exception: unknown, host: ArgumentsHost) {

        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request>();

        const { statusCode, message, error } = this.resolveException(exception);

        if (statusCode >= 500) {
            this.logger.error(
                `${request.method} ${request.url} -> ${statusCode}`,
                exception instanceof Error ? exception.stack : String(exception),
            );
        } else {
            this.logger.warn(
                `${request.method} ${request.url} -> ${statusCode} : ${JSON.stringify(message)}`,
            );
        }

        const body: ErrorResponseBody = {
            statusCode,
            message,
            error,
            timestamp: new Date().toISOString(),
            path: request.url,
        };

        response.status(statusCode).json(body);

    }

    private resolveException(exception: unknown): {
        statusCode: number;
        message: string | string[];
        error: string;
    } {
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

        if (exception instanceof Prisma.PrismaClientKnownRequestError) {
            switch (exception.code) {
                case 'P2002':
                return {
                    statusCode: HttpStatus.CONFLICT,
                    message: 'Une ressource avec cette valeur unique existe déjà.',
                    error: 'Conflict',
                };
                case 'P2025':
                return {
                    statusCode: HttpStatus.NOT_FOUND,
                    message: 'Ressource introuvable.',
                    error: 'Not Found',
                };
                case 'P2003':
                return {
                    statusCode: HttpStatus.CONFLICT,
                    message: 'Action impossible : contrainte de relation avec une autre ressource.',
                    error: 'Conflict',
                };
                default:
                return {
                    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
                    message: 'Erreur de base de données.',
                    error: 'Internal Server Error',
                };
            }
        }

        return {
            statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
            message: 'Une erreur interne est survenue.',
            error: 'Internal Server Error',
        };
    }
}