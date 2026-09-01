import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { PlatformGatewayService } from './gateway/platform-gateway.service';
import { createGeneratedBackendProxyMiddleware } from './gateway/generated-backend-proxy.middleware';
import { createGatewayRateLimiter } from './gateway/gateway-rate-limiter.middleware';

async function bootstrap() {

    const app = await NestFactory.create(AppModule);

    // Without this, a SIGTERM (deploy, `docker stop`, `pm2 reload`, ...) kills the process
    // immediately - Nest's `onModuleDestroy`/`beforeApplicationShutdown` hooks never run, which
    // means the BullMQ Worker inside GenerationProcessor never gets a chance to close cleanly.
    // This doesn't make a mid-generation restart free (a build in progress still gets cut off),
    // but it's what lets BullMQ release its job lock immediately instead of leaving it to expire
    // via `lockDuration`, and it's a prerequisite for `GenerationProcessor`'s own reconciliation
    // logic (`onApplicationBootstrap` / the `failed` WorkerEvent) to be reliably reached on the
    // next boot rather than racing an unclean kill.
    app.enableShutdownHooks();

    const configService = app.get(ConfigService);

    app.use(helmet());

    app.enableCors({

        origin: configService.get<string>(
            'CORS_ORIGIN',
            'http://localhost:9173'
        ),

        credentials: true,

    });

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

    app.use(
        gatewayPrefix,
        createGatewayRateLimiter({ windowMs: 60_000, maxRequestsPerWindow: 120 }),
    );
    app.use(createGeneratedBackendProxyMiddleware(platformGateway, gatewayPrefix));

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

    const port = configService.get<number>('PORT', 4803);
    const isProduction = configService.get<string>('NODE_ENV') === 'production';

    // SECURITY: the interactive OpenAPI explorer documents every route and DTO shape on this
    // API. That is valuable in development but is unnecessary reconnaissance information to
    // hand to an unauthenticated caller in production, so it is only mounted outside of
    // `production`.
    if (!isProduction) {
        const swaggerConfig = new DocumentBuilder()
            .setTitle('BPG Core API')
            .setDescription('API du générateur BPG (Backend Platform Generator)')
            .setVersion('0.1.0')
            .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
            .build();

        const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
        SwaggerModule.setup('api/docs', app, swaggerDocument);
    }

    await app.listen(port);

    Logger.log(`back-os Backend listening on ${port}`, 'Bootstrap');

}

bootstrap();
