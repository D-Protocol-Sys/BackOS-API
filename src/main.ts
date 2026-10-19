import { NestFactory } from '@nestjs/core';
import { Logger, ConsoleLogger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
    // OPS-007: LOG_FORMAT=json switches to structured JSON logs (one object per line), easier to
    // ship to a log pipeline; the default human-readable format is kept for development.
    const app = await NestFactory.create(AppModule, {
        logger: process.env.LOG_FORMAT === 'json' ? new ConsoleLogger({ json: true }) : undefined,
    });

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

    configureApp(app);

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

void bootstrap();
