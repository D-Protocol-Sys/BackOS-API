import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';

/**
 * Builds the application the way production does (`src/main.ts`): the same `/api` prefix, request
 * validation, error format, CORS and generated-backend gateway, through `configureApp()`.
 *
 * Do not call `createNestApplication()` yourself in an end-to-end test: you would get a bare
 * application whose routes have no `/api` prefix, and every request would answer 404.
 */
export async function createTestApp(): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    const app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    return app;
}
