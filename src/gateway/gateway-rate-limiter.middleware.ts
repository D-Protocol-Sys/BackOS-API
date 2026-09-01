import { Request, Response, NextFunction } from 'express';

interface WindowState {
    count: number;
    windowStartedAt: number;
}

/**
 * A small, dependency-free, in-memory fixed-window rate limiter, scoped specifically to the
 * generated-backend gateway proxy (`/generated/:slug/*`).
 *
 * WHY THIS EXISTS: `JwtAuthGuard`, `PermissionsGuard`, and `ThrottlerGuard` are all wired up as
 * NestJS `APP_GUARD` providers, which only run for requests that go through Nest's own routing
 * / controller pipeline. The gateway proxy is intentionally mounted as raw Express middleware
 * via `app.use(...)` in `main.ts`, *before* Nest's router, specifically so it can forward
 * traffic to generated backends without being subjected to BackOS's own authentication rules
 * (a generated backend manages its own, independent authentication - it is not a BackOS
 * resource). One side effect of that design is that `ThrottlerGuard`'s global rate limit never
 * applies to this path either. This middleware is the replacement safety net for that specific
 * gap - it does not replace or duplicate `ThrottlerGuard` anywhere else in the application.
 *
 * LIMITATIONS (intentionally kept simple for a single-process deployment): this is an
 * in-memory, per-process counter. If BackOS itself is ever horizontally scaled across multiple
 * Node.js processes/containers, each instance enforces its own independent limit rather than a
 * shared global one. For a multi-instance deployment, replace this with a Redis-backed limiter
 * (the codebase already depends on Redis for other features) using the same interface.
 */
export function createGatewayRateLimiter(options: { windowMs: number; maxRequestsPerWindow: number }) {
    const { windowMs, maxRequestsPerWindow } = options;
    const requestsByIp = new Map<string, WindowState>();

    // Periodically forget IPs that have not made a request recently, so this Map cannot grow
    // without bound over the lifetime of a long-running process.
    const sweepIntervalHandle = setInterval(() => {
        const now = Date.now();
        for (const [ip, state] of requestsByIp.entries()) {
            if (now - state.windowStartedAt > windowMs) {
                requestsByIp.delete(ip);
            }
        }
    }, windowMs);
    sweepIntervalHandle.unref();

    return function gatewayRateLimiterMiddleware(req: Request, res: Response, next: NextFunction) {
        const ip = req.ip ?? 'unknown';
        const now = Date.now();

        const existing = requestsByIp.get(ip);
        if (!existing || now - existing.windowStartedAt > windowMs) {
            requestsByIp.set(ip, { count: 1, windowStartedAt: now });
            return next();
        }

        existing.count += 1;
        if (existing.count > maxRequestsPerWindow) {
            res.status(429).json({
                statusCode: 429,
                message: 'Too many requests to generated backends from this client. Please slow down.',
            });
            return;
        }

        next();
    };
}
