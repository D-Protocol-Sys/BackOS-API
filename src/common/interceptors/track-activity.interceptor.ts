import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * NestJS Interceptor that updates the requesting user's `lastActiveAt` timestamp in the database.
 * Designed to execute asynchronously without blocking HTTP response delivery (fire-and-forget).
 */
@Injectable()
export class TrackActivityInterceptor implements NestInterceptor {
    constructor(private readonly prisma: PrismaService) {}

    /**
     * Intercepts incoming HTTP requests to track authenticated user activity.
     */
    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        const request = context.switchToHttp().getRequest();
        const userId: string | undefined = request.user?.userId;

        if (userId) {
            // Fire-and-forget pattern: execution is non-blocking to prevent adding latency to the request.
            // The SQL condition throttles DB updates to execute only if the last update was > 1 minute ago,
            // avoiding unnecessary write load without requiring a prior SELECT query.
            this.prisma
                .$executeRaw`UPDATE users SET "lastActiveAt" = now() WHERE id = ${userId} AND ("lastActiveAt" IS NULL OR "lastActiveAt" < now() - interval '1 minute')`.catch(
                () => {
                    /* Silent error handling: a tracking failure should never disrupt the primary request flow */
                },
            );
        }

        return next.handle();
    }
}
