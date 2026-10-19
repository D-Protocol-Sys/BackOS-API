import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { requestContextMiddleware } from './common/request-context/request-context';
import { createGatewayRateLimiter } from './gateway/gateway-rate-limiter.middleware';
import { createGeneratedBackendProxyMiddleware } from './gateway/generated-backend-proxy.middleware';
import { PlatformGatewayService } from './gateway/platform-gateway.service';

/**
 * Everything that turns a bare Nest application into BackOS's HTTP server: proxy trust, request
 * ids, security headers, the generated-backend gateway, CORS, request validation, the error format
 * and the `/api` prefix.
 *
 * It lives here, and not inline in `main.ts`, so that the end-to-end tests can build the SAME
 * application as production (see test/helpers/create-test-app.ts). Before, the tests built a bare
 * one: its routes had no `/api` prefix and no request validation, so they exercised something that
 * does not exist in production.
 *
 * Not in here, on purpose: starting to listen on a port, shutdown hooks and the Swagger explorer,
 * which only make sense for the real process (see `main.ts`).
 *
 * ORDER MATTERS inside this function (see the comments below): do not rearrange the statements.
 */
export function configureApp(app: INestApplication): void {
    const configService = app.get(ConfigService);

    // SECURITY FIX (audit #4 - elevated): `deploy/docker-compose.prod.yml` places this
    // application behind Traefik, but Express (underlying Nest's HTTP layer) does not trust
    // `X-Forwarded-For` by default. Without this, `req.ip` resolves to Traefik's own container
    // IP for every single request, which silently breaks two security-relevant systems that
    // depend on the real client IP:
    //   1. `ThrottlerGuard` (per-IP rate limiting on /auth/login, /auth/mfa/confirm, file
    //      uploads, backups, ...) - all traffic would appear to share one IP, so the entire
    //      user base would share a single quota instead of each client being limited
    //      individually.
    //   2. `AuditLogService` - every login/failed-login/lockout audit entry would record the
    //      same internal proxy IP, making the log useless for investigating a real brute-force
    //      source after the fact.
    // `TRUST_PROXY_HOPS` lets the exact number of trusted reverse-proxy hops be tuned per
    // deployment (Express's `trust proxy` setting - see http://expressjs.com/en/guide/behind-proxies.html);
    // it defaults to `0` (no proxy trusted: `X-Forwarded-For` cannot be forged), and the prod, demo
    // and lan compose files set it to `1`, matching the single-Traefik-hop topology.
    // Traefik forwards `X-Forwarded-For` by default, so no Traefik-side change is required.
    const trustProxyHops = configService.get<number>('TRUST_PROXY_HOPS', 0);
    // `app` is typed as the generic `INestApplication`, which doesn't expose Express-specific
    // methods like `.set()` even though Express is what's actually running underneath by
    // default. `getHttpAdapter().getInstance()` is the standard NestJS way to reach the
    // underlying Express instance without switching `NestFactory.create()` to
    // `NestExpressApplication` (a wider change that would ripple into every other `app.*` call
    // in this file).
    app.getHttpAdapter().getInstance().set('trust proxy', trustProxyHops);

    app.use(requestContextMiddleware);

    app.use(helmet());

    // ORDER MATTERS: the gateway is mounted BEFORE the orchestrator's own `enableCors()` below.
    // Express runs middleware in registration order, and `cors()` answers OPTIONS preflights
    // itself. With CORS first, a browser calling a generated backend from another origin (e.g. a
    // portfolio front hosted elsewhere) would get its preflight answered with the ORCHESTRATOR's
    // allowed origin instead of the generated backend's own `CORS_ORIGINS`. Requests under the
    // gateway prefix are now handled entirely by the generated backend's CORS configuration.
    // ------------------------------------------------------------------------------------
    // GENERATED BACKEND GATEWAY
    // ------------------------------------------------------------------------------------
    // Mounted BEFORE `setGlobalPrefix('api')` and before Nest's own router gets a chance to
    // run, so that traffic for a generated platform's public API - e.g.
    // `https://backos.com/generated/portfolio/getprojects` - is transparently forwarded to
    // that platform's internal, loopback-only backend process WITHOUT going through BackOS's
    // own `JwtAuthGuard` / `PermissionsGuard` (a generated backend authenticates its own
    // callers independently; it is not a BackOS resource). See
    // `src/gateway/GATEWAY_README.md` for the full design rationale, including why this
    // deliberately bypasses Nest's guard pipeline and what compensates for that.
    const gatewayPrefix = configService.get<string>('GENERATED_BACKEND_GATEWAY_PREFIX', '/generated');
    const platformGateway = app.get(PlatformGatewayService);

    app.use(gatewayPrefix, createGatewayRateLimiter({ windowMs: 60_000, maxRequestsPerWindow: 120 }));
    app.use(createGeneratedBackendProxyMiddleware(platformGateway, gatewayPrefix));

    // SECURITY FIX (SEC-020): CORS_ORIGIN accepts a comma-separated list. The wildcard "*" is
    // only honoured WITHOUT credentials - combining both is refused by browsers anyway and
    // signalled a misconfiguration (it used to be the LAN default).
    const corsOrigins = configService
        .get<string>('CORS_ORIGIN', 'http://localhost:9173')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
    const allowAnyOrigin = corsOrigins.includes('*');
    if (allowAnyOrigin) {
        Logger.warn(
            'CORS_ORIGIN="*": any origin may call the API (without credentials). Set explicit origins in production.',
            'Bootstrap',
        );
    }
    app.enableCors({
        origin: allowAnyOrigin ? '*' : corsOrigins,
        credentials: !allowAnyOrigin,
        exposedHeaders: ['X-Request-Id'],
    });

    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
            transformOptions: { enableImplicitConversion: true },
        }),
    );

    app.useGlobalFilters(new AllExceptionsFilter());

    app.setGlobalPrefix('api');
}
