import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'events';
import { DockerRuntimeManagerService } from './docker-runtime-manager.service';

/**
 * Fakes `child_process.spawn('docker', ...)` so these tests never touch a real Docker daemon -
 * they exercise DockerRuntimeManagerService's own logic (URL rewriting, removal-race handling)
 * in isolation, which is what makes them fast and safe to run in CI without Docker installed.
 */
jest.mock('child_process', () => ({
    // Keep the real module (command-runner.util promisifies execFile at import time) and only
    // replace spawn().
    ...jest.requireActual('child_process'),
    spawn: jest.fn(),
}));
import { spawn } from 'child_process';

function fakeChildProcess(exitCode: number, stdout = '') {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    // Real spawn() emits asynchronously - queue a microtask so `await` points in the code under
    // test actually yield, the same way they would against a real child process.
    queueMicrotask(() => {
        if (stdout) child.stdout.emit('data', Buffer.from(stdout));
        child.emit('close', exitCode);
    });
    return child;
}

describe('DockerRuntimeManagerService', () => {
    let service: DockerRuntimeManagerService;
    let configValues: Record<string, string>;

    beforeEach(() => {
        (spawn as jest.Mock).mockReset();
        configValues = {};
        const configService = {
            get: (key: string, fallback?: string) => configValues[key] ?? fallback,
        } as unknown as ConfigService;
        // Only ConfigService is exercised by the methods under test below - prisma/gateway are
        // never called by dockerReachableDatabaseUrl/waitForContainerRemoval, so plain stubs
        // (rather than full Nest TestingModule mocks) keep these tests fast and focused.
        service = new DockerRuntimeManagerService({} as any, configService, {} as any);
    });

    // ------------------------------------------------------------------------------------------
    // dockerReachableDatabaseUrl() - see the BUGFIX doc comment on the method itself: this is
    // what makes a generated backend able to reach Postgres from inside its own Docker
    // container, which is the exact bug reported earlier ("works with spawn, not with Docker").
    // ------------------------------------------------------------------------------------------
    describe('dockerReachableDatabaseUrl', () => {
        it('rewrites a localhost DATABASE_URL to the configured Docker-reachable host', () => {
            configValues['GENERATED_BACKEND_DOCKER_DB_HOST'] = 'host.docker.internal';
            const rewritten = (service as any).dockerReachableDatabaseUrl(
                'postgresql://user:pass@localhost:5432/mydb?schema=public',
            );
            expect(rewritten).toBe('postgresql://user:pass@host.docker.internal:5432/mydb?schema=public');
        });

        it('rewrites 127.0.0.1 the same way as localhost', () => {
            configValues['GENERATED_BACKEND_DOCKER_DB_HOST'] = 'host.docker.internal';
            const rewritten = (service as any).dockerReachableDatabaseUrl(
                'postgresql://user:pass@127.0.0.1:5432/mydb',
            );
            expect(rewritten).toContain('@host.docker.internal:5432/');
        });

        it('rewrites to the Postgres Compose service name in the containerized-prod shape', () => {
            configValues['GENERATED_BACKEND_DOCKER_DB_HOST'] = 'postgres';
            const rewritten = (service as any).dockerReachableDatabaseUrl(
                'postgresql://user:pass@localhost:5432/mydb',
            );
            expect(rewritten).toContain('@postgres:5432/');
        });

        it('leaves an already-remote hostname untouched (managed/external database)', () => {
            configValues['GENERATED_BACKEND_DOCKER_DB_HOST'] = 'host.docker.internal';
            const remoteUrl = 'postgresql://user:pass@db.managed-provider.example.com:5432/mydb';
            expect((service as any).dockerReachableDatabaseUrl(remoteUrl)).toBe(remoteUrl);
        });

        it('returns the original string unmodified if it is not a parseable URL', () => {
            const garbage = 'not-a-url';
            expect((service as any).dockerReachableDatabaseUrl(garbage)).toBe(garbage);
        });

        it('preserves credentials, port, path, and query string while only touching the host', () => {
            configValues['GENERATED_BACKEND_DOCKER_DB_HOST'] = 'host.docker.internal';
            const rewritten: string = (service as any).dockerReachableDatabaseUrl(
                'postgresql://backos_football_owner:s3cr3t@localhost:5432/backos_football?schema=public',
            );
            const url = new URL(rewritten);
            expect(url.username).toBe('backos_football_owner');
            expect(url.password).toBe('s3cr3t');
            expect(url.port).toBe('5432');
            expect(url.pathname).toBe('/backos_football');
            expect(url.searchParams.get('schema')).toBe('public');
        });
    });

    // ------------------------------------------------------------------------------------------
    // waitForContainerRemoval() - see the "Conflict: name already in use" bug this fixes: a
    // stale `docker rm -f` can report success before the daemon has actually finished detaching
    // the container's network, so the very next `docker run` can lose the race.
    // ------------------------------------------------------------------------------------------
    describe('waitForContainerRemoval', () => {
        it('returns immediately once `docker inspect` reports the container gone', async () => {
            (spawn as jest.Mock).mockImplementationOnce(() => fakeChildProcess(1)); // "no such object"
            const start = Date.now();
            await (service as any).waitForContainerRemoval('backos-gen-football', 10, 5);
            expect(Date.now() - start).toBeLessThan(200);
            expect(spawn).toHaveBeenCalledTimes(1);
        });

        it('polls until the container disappears instead of racing the very next call', async () => {
            (spawn as jest.Mock)
                .mockImplementationOnce(() => fakeChildProcess(0, 'still-here-id')) // 1st poll: still present
                .mockImplementationOnce(() => fakeChildProcess(0, 'still-here-id')) // 2nd poll: still present
                .mockImplementationOnce(() => fakeChildProcess(1)); // 3rd poll: gone

            await (service as any).waitForContainerRemoval('backos-gen-football', 10, 5);
            expect(spawn).toHaveBeenCalledTimes(3);
        });

        it('gives up after the configured number of attempts without throwing', async () => {
            (spawn as jest.Mock).mockImplementation(() => fakeChildProcess(0, 'still-here-id'));
            await expect(
                (service as any).waitForContainerRemoval('backos-gen-football', 3, 1),
            ).resolves.toBeUndefined();
            expect(spawn).toHaveBeenCalledTimes(3);
        });
    });

    // ------------------------------------------------------------------------------------------
    // Per-tenant network naming - see ensurePlatformNetwork()'s doc comment for the lateral-
    // movement issue this prevents (one tenant's container reaching another's directly).
    // ------------------------------------------------------------------------------------------
    describe('platformNetworkName', () => {
        it('derives a unique, slug-scoped network name from the configured prefix', () => {
            configValues['GENERATED_BACKEND_DOCKER_NETWORK'] = 'backos-gen-net';
            expect((service as any).platformNetworkName('football')).toBe('backos-gen-net-football');
            expect((service as any).platformNetworkName('restaurant')).toBe('backos-gen-net-restaurant');
        });

        it('never produces the same network name for two different platforms', () => {
            const a = (service as any).platformNetworkName('football');
            const b = (service as any).platformNetworkName('restaurant');
            expect(a).not.toBe(b);
        });
    });
});
