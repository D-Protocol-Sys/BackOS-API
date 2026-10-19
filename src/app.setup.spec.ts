import { Body, Controller, Get, INestApplication, Module, Post } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { IsString } from 'class-validator';
import request from 'supertest';
import { configureApp } from './app.setup';
import { PlatformGatewayService } from './gateway/platform-gateway.service';

// The real proxy comes from an ES-module-only package that the unit-test setup does not load.
// It is not what is tested here (only the ORDER in which configureApp mounts things is).
jest.mock('./gateway/generated-backend-proxy.middleware', () => ({
    createGeneratedBackendProxyMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

class EchoDto {
    @IsString()
    name!: string;
}

@Controller('echo')
class EchoController {
    @Get()
    hello() {
        return { ok: true };
    }

    @Post()
    echo(@Body() dto: EchoDto) {
        return dto;
    }
}

// The gateway is only consulted for requests under /generated, which these tests do not make.
@Module({ controllers: [EchoController], providers: [{ provide: PlatformGatewayService, useValue: {} }] })
class FakeAppModule {}

/**
 * configureApp() is what makes the end-to-end tests exercise the same HTTP server as production.
 * These tests pin down what the tests (and the front end) rely on.
 */
describe('configureApp', () => {
    let app: INestApplication;

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), FakeAppModule],
        }).compile();

        app = moduleRef.createNestApplication();
        configureApp(app);
        await app.init();
    });

    afterAll(async () => {
        await app.close();
    });

    it('serves every route under /api, and nothing without the prefix', async () => {
        await request(app.getHttpServer()).get('/api/echo').expect(200);
        await request(app.getHttpServer()).get('/echo').expect(404);
    });

    it('rejects a body with a property the DTO does not declare (forbidNonWhitelisted)', async () => {
        await request(app.getHttpServer()).post('/api/echo').send({ name: 'x', extra: 1 }).expect(400);
        await request(app.getHttpServer()).post('/api/echo').send({ name: 'x' }).expect(201);
    });

    it('rejects a body that does not satisfy the DTO', async () => {
        await request(app.getHttpServer()).post('/api/echo').send({}).expect(400);
    });

    it('sets the security headers (helmet) and echoes a request id', async () => {
        const res = await request(app.getHttpServer()).get('/api/echo').expect(200);

        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['x-request-id']).toBeDefined();
    });
});
