import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { bootstrapOwnerSession } from './helpers/auth.helper';

/**
 * The critical path requested: generate a platform, start its Docker container for real, call
 * its API through the public gateway, then stop it - proving the whole chain works together,
 * not just each piece in isolation. Slow (real `docker build`/`docker run`) and requires Docker
 * on PATH - keep this suite separate from faster unit/integration specs so it isn't run on
 * every save.
 *
 * Needs test/helpers/auth.helper.ts finished first (see the TODO there) before this will run
 * end to end - everything from platform creation onward is already wired against the real API.
 */
describe('Platform lifecycle (generate -> Docker start -> gateway call -> stop)', () => {
    let app: INestApplication;
    let accessToken: string;

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        await app.init();

        ({ accessToken } = await bootstrapOwnerSession(app));
    });

    afterAll(async () => {
        await app.close();
    });

    it('generates, starts under Docker, serves a real request, and stops cleanly', async () => {
        const authed = () => request(app.getHttpServer()).set('Authorization', `Bearer ${accessToken}`);

        // 1. Create the platform (see src/platforms/dto/create-platform.dto.ts).
        const createRes = await authed()
            .post('/api/platforms')
            .send({ name: `e2e-football-${Date.now()}` })
            .expect(201);
        const platformId: string = createRes.body.id;
        const slug: string = createRes.body.slug;
        expect(slug).toBeTruthy();

        // 2. Trigger generation (queued to BullMQ - see generator.controller.ts) and poll the
        // platform's own status (DRAFT -> GENERATING -> ACTIVE, see generation.processor.ts)
        // until it finishes. Real `pnpm install` + `prisma migrate` inside the generated
        // project, so this is genuinely slow - the 120s default testTimeout in jest-e2e.json
        // assumes a warm pnpm store; raise it if your first run is a cold cache.
        await authed().post(`/api/platforms/${platformId}/generate`).expect(201);
        await pollUntil(
            async () => (await authed().get(`/api/platforms/${platformId}`).expect(200)).body.status,
            (status) => status === 'ACTIVE' || status === 'DRAFT', // DRAFT would mean generation FAILED and reverted - see below
            { attempts: 60, delayMs: 2000 },
        );
        const afterGeneration = await authed().get(`/api/platforms/${platformId}`).expect(200);
        expect(afterGeneration.body.status).toBe('ACTIVE');

        // 3. Start the Docker container for real and poll runtime status until RUNNING - this
        // is exactly the flow debugged earlier in this conversation (Conflict/name-in-use race,
        // DATABASE_URL host rewrite), so a green result here is a real regression guard for both.
        await authed().post(`/api/platforms/${platformId}/runtime/start`).expect(201);
        await pollUntil(
            async () => (await authed().get(`/api/platforms/${platformId}/runtime/status`).expect(200)).body.status,
            (status) => status === 'RUNNING' || status === 'CRASHED',
            { attempts: 30, delayMs: 1000 },
        );
        const runtimeStatus = await authed().get(`/api/platforms/${platformId}/runtime/status`).expect(200);
        expect(runtimeStatus.body.status).toBe('RUNNING');

        // 4. The actual point of this test: a real HTTP call through the public gateway
        // (`/generated/<slug>/...`, see generated-backend-proxy.middleware.ts), proxied to the
        // generated backend's own container - not calling the container directly.
        const proxied = await request(app.getHttpServer()).get(`/generated/${slug}/health`).expect(200);
        expect(proxied.body).toMatchObject({ status: 'ok' });

        // 5. Stop, and confirm the gateway stops routing to it (404, indistinguishable from an
        // unknown slug by design - see the doc comment on createGeneratedBackendProxyMiddleware).
        await authed().post(`/api/platforms/${platformId}/runtime/stop`).expect(201);
        await pollUntil(
            async () => (await authed().get(`/api/platforms/${platformId}/runtime/status`).expect(200)).body.status,
            (status) => status === 'STOPPED',
            { attempts: 30, delayMs: 1000 },
        );
        await request(app.getHttpServer()).get(`/generated/${slug}/health`).expect(404);
    });
});

async function pollUntil<T>(
    read: () => Promise<T>,
    isDone: (value: T) => boolean,
    { attempts, delayMs }: { attempts: number; delayMs: number },
): Promise<T> {
    let last: T;
    for (let i = 0; i < attempts; i++) {
        last = await read();
        if (isDone(last)) return last;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(`pollUntil() gave up after ${attempts} attempts. Last value: ${JSON.stringify(last!)}`);
}
