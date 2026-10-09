import { ConfigService } from '@nestjs/config';
import { RuntimeRecoveryService } from './runtime-recovery.service';

type Platform = { id: string; slug: string };

function build(options: {
    platforms: Platform[];
    statuses?: Record<string, 'RUNNING' | 'STARTING' | 'STOPPED' | 'CRASHED'>;
    startImpl?: (id: string) => Promise<unknown>;
    config?: Record<string, unknown>;
}) {
    const findMany = jest.fn().mockResolvedValue(options.platforms);
    const prisma = { platform: { findMany } };
    const getStatus = jest.fn(async (id: string) => ({ status: options.statuses?.[id] ?? 'CRASHED' }));
    const start = jest.fn(options.startImpl ?? (async () => ({ message: 'Starting container…' })));
    const runtime = { getStatus, start };
    const config = {
        GENERATED_BACKEND_RESTORE_RETRY_DELAY_MS: 0,
        GENERATED_BACKEND_RESTORE_ATTEMPTS: 3,
        ...options.config,
    };
    const configService = {
        get: (key: string, fallback?: unknown) => (key in config ? config[key] : fallback),
    } as unknown as ConfigService;

    const service = new RuntimeRecoveryService(prisma as never, configService, runtime as never);
    return { service, findMany, getStatus, start };
}

describe('RuntimeRecoveryService', () => {
    it('only looks at ACTIVE platforms that were left RUNNING or STARTING and have a port', async () => {
        const { service, findMany } = build({ platforms: [] });
        await service.run();

        const where = findMany.mock.calls[0][0].where;
        expect(where.status).toBe('ACTIVE');
        expect(where.runtimeStatus).toEqual({ in: ['RUNNING', 'STARTING'] });
        expect(where.generatedPort).toEqual({ not: null });
    });

    it('starts a platform whose container is no longer running', async () => {
        const { service, start } = build({ platforms: [{ id: 'p1', slug: 'portfolio' }], statuses: { p1: 'CRASHED' } });

        const report = await service.run();

        expect(start).toHaveBeenCalledWith('p1');
        expect(report.restored).toEqual(['portfolio']);
        expect(report.failed).toEqual([]);
    });

    it('leaves alone a platform whose container is still running (only the stack restarted)', async () => {
        const { service, start } = build({
            platforms: [{ id: 'p1', slug: 'portfolio' }, { id: 'p2', slug: 'blog' }],
            statuses: { p1: 'RUNNING', p2: 'STARTING' },
        });

        const report = await service.run();

        expect(start).not.toHaveBeenCalled();
        expect(report.alreadyRunning).toEqual(['portfolio', 'blog']);
    });

    it('keeps going when one platform fails, and reports it', async () => {
        const { service, start } = build({
            platforms: [{ id: 'p1', slug: 'broken' }, { id: 'p2', slug: 'portfolio' }],
            startImpl: async (id) => {
                if (id === 'p1') throw new Error('image build failed');
                return {};
            },
            config: { GENERATED_BACKEND_RESTORE_ATTEMPTS: 1 },
        });

        const report = await service.run();

        expect(start).toHaveBeenCalledTimes(2);
        expect(report.restored).toEqual(['portfolio']);
        expect(report.failed).toEqual(['broken']);
    });

    it('retries a failing platform (Docker may answer a little after the orchestrator boots)', async () => {
        let calls = 0;
        const { service, start } = build({
            platforms: [{ id: 'p1', slug: 'portfolio' }],
            startImpl: async () => {
                calls += 1;
                if (calls < 3) throw new Error('Cannot connect to the Docker daemon');
                return {};
            },
        });

        const report = await service.run();

        expect(start).toHaveBeenCalledTimes(3);
        expect(report.restored).toEqual(['portfolio']);
        expect(report.failed).toEqual([]);
    });

    it('gives up after the configured number of attempts', async () => {
        const { service, start } = build({
            platforms: [{ id: 'p1', slug: 'portfolio' }],
            startImpl: async () => {
                throw new Error('still down');
            },
            config: { GENERATED_BACKEND_RESTORE_ATTEMPTS: 2 },
        });

        const report = await service.run();

        expect(start).toHaveBeenCalledTimes(2);
        expect(report.failed).toEqual(['portfolio']);
    });

    it('does not schedule anything when GENERATED_BACKEND_AUTO_RESTORE=false', () => {
        jest.useFakeTimers();
        try {
            const { service, findMany } = build({ platforms: [], config: { GENERATED_BACKEND_AUTO_RESTORE: false } });
            service.onApplicationBootstrap();
            jest.runAllTimers();
            expect(findMany).not.toHaveBeenCalled();
        } finally {
            jest.useRealTimers();
        }
    });
});
