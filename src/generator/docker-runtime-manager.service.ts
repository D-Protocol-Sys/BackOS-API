import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformGatewayService } from '../gateway/platform-gateway.service';
import { GENERATED_BACKEND_API_PREFIX, GENERATED_BACKEND_CONTAINER_PORT } from './generated-backend.constants';

/**
 * Drop-in alternative to `RuntimeManagerService` (same public method shapes: `start`, `stop`,
 * `getStatus`, `getLogs`) that runs every generated platform backend as its OWN Docker
 * container instead of a bare `child_process.spawn` on the shared host.
 *
 * WHY THIS EXISTS (see the user-facing explanation this was written for): `spawn`-based
 * isolation only gets you a separate OS process - all generated backends still share the host's
 * filesystem, network namespace, and resource pool (CPU/RAM) with each other and with the
 * orchestrator itself. A bug or an abusive tenant in one generated platform can still exhaust
 * host memory, fill the disk, or (if it ever escaped its cwd) touch another platform's files.
 * Docker gives each platform:
 *   - Its own filesystem and process namespace (can't see/signal other containers' processes).
 *   - Hard CPU/memory limits (`--cpus`, `--memory`) so one platform can't starve the others.
 *   - A non-root user and a read-only root filesystem (see `dockerfileTemplate()`).
 *   - Still ONLY reachable via `127.0.0.1:<allocatedPort>` on the host - identical external
 *     contract to the process-based runtime, so `PlatformGatewayService` needs no changes.
 *
 * NOT WIRED IN BY DEFAULT: swapping this in for `RuntimeManagerService` is an infrastructure
 * decision (requires Docker installed on the host, and the orchestrator process to have access
 * to the Docker socket/CLI) that shouldn't happen silently as part of a bug-fix pass. To enable
 * it, bind this class instead of `RuntimeManagerService` wherever it's injected
 * (`GeneratorController`, `GeneratorModule`) - the method signatures are intentionally
 * identical so that swap is the only change needed.
 *
 * PREREQUISITE: the `docker` CLI must be on PATH and usable by the user running this Node
 * process (either in the `docker` group, or via rootless Docker - avoid giving the orchestrator
 * root/socket access beyond what it needs, since that access is itself a privilege-escalation
 * surface worth its own review).
 */
@Injectable()
export class DockerRuntimeManagerService {
    private readonly logger = new Logger(DockerRuntimeManagerService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly configService: ConfigService,
        private readonly platformGateway: PlatformGatewayService,
    ) {}

    private containerName(slug: string): string {
        return `backos-gen-${slug}`;
    }

    private imageTag(slug: string): string {
        return `backos-gen/${slug}:latest`;
    }

    /**
     * SECURITY (per-tenant network isolation): every generated backend used to share a single
     * Docker network (`GENERATED_BACKEND_DOCKER_NETWORK`, e.g. the default `bridge`). Containers
     * on the same user-defined Docker network can reach each other directly by container name/IP
     * - so platform A's generated backend could call platform B's generated backend on its
     * internal port DIRECTLY, completely bypassing `PlatformGatewayService` and whatever
     * per-platform auth the generated code itself implements. Each generated backend runs
     * arbitrary, per-tenant code, so this was a real lateral-movement path between tenants.
     *
     * Each platform now gets its OWN dedicated network (`backos-gen-net-<slug>`), created lazily
     * and reused across restarts (idempotent - `ignoreFailure: true` swallows the "already
     * exists" error). Only that platform's own container is ever attached to it, plus the
     * database (see `ensureDatabaseReachableOnNetwork()`) - never other tenants' containers, the
     * orchestrator's Redis, or anything else. Deliberately NOT created with `--internal`: unlike
     * a fully airgapped network, generated backends still need normal outbound internet access
     * for legitimate third-party integrations (SMTP, payment webhooks, etc.) - the isolation
     * property this provides is tenant-to-tenant, not internet egress.
     */
    private platformNetworkName(slug: string): string {
        const prefix = this.configService.get<string>('GENERATED_BACKEND_DOCKER_NETWORK', 'backos-gen-net');
        return `${prefix}-${slug}`;
    }

    private async ensurePlatformNetwork(slug: string): Promise<string> {
        const networkName = this.platformNetworkName(slug);
        await this.runDockerCommand(['network', 'create', '--driver', 'bridge', networkName], undefined, { ignoreFailure: true });
        return networkName;
    }

    /**
     * Attaches the database container to a platform's dedicated network, if configured, so the
     * generated backend can reach it by service/container name (see `dockerReachableDatabaseUrl()`)
     * without being on the SAME network as any other tenant. Idempotent - re-connecting an
     * already-connected container is ignored, not an error.
     *
     * Deliberately a no-op when `GENERATED_BACKEND_DB_CONTAINER_NAME` is unset: a managed/remote
     * database (RDS, Cloud SQL, ...) is not a container this Docker daemon controls, and is
     * already reachable over the network by its real hostname regardless of which Docker network
     * the generated container is on - there is nothing to connect in that case.
     */
    private async ensureDatabaseReachableOnNetwork(networkName: string): Promise<void> {
        const dbContainerName = this.configService.get<string>('GENERATED_BACKEND_DB_CONTAINER_NAME', '');
        if (!dbContainerName) return;
        await this.runDockerCommand(['network', 'connect', networkName, dbContainerName], undefined, { ignoreFailure: true });
    }

    /**
     * BUGFIX (generated backend unreachable ONLY under Docker, works fine under
     * `RuntimeManagerService`): `envTemplate()` writes `DATABASE_URL`/`SHADOW_DATABASE_URL` into
     * the generated project's `.env` using `database.provisioningHost`, which defaults to
     * `localhost` - correct for `RuntimeManagerService`, whose child process shares the
     * orchestrator's own network namespace (spawned directly on the host). A Docker container on
     * its own bridge network does NOT share that namespace: its own `localhost` resolves to the
     * container itself, not wherever Postgres actually lives. The generated backend's Prisma
     * client then fails to connect on boot, the process never becomes healthy, `runtimeStatus`
     * never reaches `RUNNING`, and the gateway (`PlatformGatewayService.resolveTarget()`) never
     * routes to it.
     *
     * This rewrites the hostname portion of a Postgres connection string from `localhost` /
     * `127.0.0.1` to `GENERATED_BACKEND_DOCKER_DB_HOST`. Two deployment shapes, same mechanism:
     *   - Orchestrator running bare-metal (`pnpm start:dev`), Postgres also on the host: set this
     *     to `host.docker.internal` (Docker's built-in DNS name for "the host machine" - resolvable
     *     on Docker Desktop out of the box, and on Linux thanks to the `--add-host` flag below).
     *   - Full containerized/production stack (see `docker-compose.prod.yml`): Postgres is itself
     *     a container reachable by its Compose service name (e.g. `postgres`) on the platform's
     *     dedicated network once `ensureDatabaseReachableOnNetwork()` has attached it there - set
     *     this to that service name instead.
     * Any OTHER hostname (a real remote/managed database) is left untouched, since it was never
     * the orchestrator's own loopback to begin with.
     */
    private dockerReachableDatabaseUrl(rawUrl: string): string {
        const dockerDbHost = this.configService.get<string>('GENERATED_BACKEND_DOCKER_DB_HOST', 'host.docker.internal');
        try {
            const url = new URL(rawUrl);
            if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
                url.hostname = dockerDbHost;
            }
            return url.toString();
        } catch {
            // Not a parseable URL (unexpected shape) - leave it exactly as-is rather than risk
            // corrupting a value we don't understand.
            return rawUrl;
        }
    }

    /**
     * Reads the `DATABASE_URL` / `SHADOW_DATABASE_URL` lines already written into the generated
     * project's `.env` by `envTemplate()`, so `start()` can rewrite just their hostname for Docker
     * reachability (see `dockerReachableDatabaseUrl()`) without needing to re-derive either value
     * from the database/provisioning layer itself.
     */
    private async readEnvDatabaseUrls(projectPath: string): Promise<{ databaseUrl?: string; shadowDatabaseUrl?: string }> {
        const envPath = path.join(projectPath, '.env');
        const content = await fsp.readFile(envPath, 'utf-8');
        const result: { databaseUrl?: string; shadowDatabaseUrl?: string } = {};
        for (const line of content.split('\n')) {
            const match = line.match(/^(DATABASE_URL|SHADOW_DATABASE_URL)=(.*)$/);
            if (!match) continue;
            const value = match[2].trim().replace(/^"(.*)"$/, '$1');
            if (match[1] === 'DATABASE_URL') result.databaseUrl = value;
            if (match[1] === 'SHADOW_DATABASE_URL') result.shadowDatabaseUrl = value;
        }
        return result;
    }

    /**
     * Builds (or refreshes, via Docker's own layer cache) the image for a platform's generated
     * backend from the `Dockerfile` written by `ProjectScaffolderService` at generation time.
     *
     * Rebuilding on every `start()` is intentionally simple and correct - Docker's layer cache
     * makes a no-op rebuild fast (seconds) when nothing changed since the last build. The
     * optimization of building once per GENERATION instead (inside `GenerationProcessor`,
     * immediately after the existing host-side `pnpm run build` step) rather than once per
     * START is a reasonable follow-up, but touches the core generation pipeline rather than
     * just the runtime layer, so it is deliberately left out of this pass.
     */
    private async buildImage(platformId: string, slug: string, projectPath: string): Promise<void> {
        const tag = this.imageTag(slug);
        await this.runDockerCommand(['build', '-t', tag, projectPath], platformId);
    }

    /**
     * Polls `docker inspect` until `name` genuinely no longer exists (rather than trusting
     * `docker rm -f`'s exit code alone) - see the call site in `start()` for why this closes a
     * real "Conflict: name already in use" race against the very next `docker run`.
     */
    private async waitForContainerRemoval(name: string, attempts = 10, delayMs = 300): Promise<void> {
        for (let i = 0; i < attempts; i++) {
            const stillThere = await this.runDockerCommand(
                ['inspect', '--format', '{{.Id}}', name],
                undefined,
                { capture: true, ignoreFailure: true },
            );
            if (!stillThere) return; // `docker inspect` failed - the name is free.
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        this.logger.warn(`Container "${name}" still present after removal wait - proceeding anyway, the next docker run may race it.`);
    }

    async start(platformId: string) {
        const platform = await this.prisma.platform.findUniqueOrThrow({ where: { id: platformId } });

        if (platform.status !== 'ACTIVE') {
            throw new BadRequestException('Generate this platform successfully at least once before starting it.');
        }
        if (!platform.generatedPort) {
            throw new BadRequestException('This platform has no allocated port yet.');
        }

        const liveStatus = await this.getLiveStatus(platform.slug, platform.runtimeStatus);
        if (liveStatus === 'RUNNING' || liveStatus === 'STARTING') {
            throw new BadRequestException('This backend is already running.');
        }

        const projectPath = this.resolveProjectPath(platform.slug);
        await this.buildImage(platformId, platform.slug, projectPath);

        const name = this.containerName(platform.slug);
        // Remove any stale, stopped container left over from a previous run under the same
        // name - `docker run` refuses to reuse a name that already exists, even if stopped.
        await this.runDockerCommand(['rm', '-f', name], platformId, { ignoreFailure: true });
        // `docker rm -f` can return successfully before the daemon has actually finished
        // detaching/cleaning up the container (network endpoint teardown in particular can lag
        // a moment behind, especially with a container's own dedicated network - see
        // ensurePlatformNetwork() - rather than the plain shared `bridge` used previously).
        // Without this wait, the `docker run` a few lines below can occasionally race an
        // in-progress removal and fail with "Conflict: name already in use" even though `rm -f`
        // just reported success for that exact container.
        await this.waitForContainerRemoval(name);

        const boundHost = this.configService.get<string>('GENERATED_BACKEND_HOST', '127.0.0.1');
        const memoryLimit = this.configService.get<string>('GENERATED_BACKEND_MEMORY_LIMIT', '256m');
        const cpuLimit = this.configService.get<string>('GENERATED_BACKEND_CPU_LIMIT', '0.5');

        // SECURITY: dedicated per-platform network - see ensurePlatformNetwork()'s doc comment
        // for why this replaced a single network shared by every tenant's generated backend.
        const network = await this.ensurePlatformNetwork(platform.slug);
        await this.ensureDatabaseReachableOnNetwork(network);

        // Persisted on the HOST (survives container recreation/rebuilds) and bind-mounted
        // read-write into the otherwise `--read-only` container - see `uploadsMulterConfigTemplate()`
        // for why `UploadsController` needs a real writable directory despite the read-only
        // rootfs, and why this must be a bind mount rather than relying on the container's own
        // filesystem (anything written to a plain container-internal path would be silently
        // lost on the next `docker rm` in `start()`/`stop()`).
        const uploadsHostDir = path.join(projectPath, 'uploads');
        await fsp.mkdir(uploadsHostDir, { recursive: true });
        // Bind mounts keep the HOST directory's ownership/permissions inside the container -
        // the image's non-root `app` user (see dockerfileTemplate()) has no guarantee its UID
        // matches whatever created this directory on the host, so without this the container
        // could get a permission-denied error on every upload despite the mount being `rw`.
        // The directory only ever holds already-validated, randomly-named uploads served back
        // read-only by everyone except this container, so the broadened permission is low-risk.
        await fsp.chmod(uploadsHostDir, 0o777);

        // BUGFIX: see dockerReachableDatabaseUrl() - the .env file's DATABASE_URL/SHADOW_DATABASE_URL
        // point at `localhost`, which is only correct for RuntimeManagerService's host-spawned
        // process, not for this container. Rewritten here and passed as explicit `-e` overrides
        // below (same pattern as the existing PORT/HOST overrides).
        const envDbUrls = await this.readEnvDatabaseUrls(projectPath);
        const dockerEnvOverrides: string[] = [];
        if (envDbUrls.databaseUrl) {
            dockerEnvOverrides.push('-e', `DATABASE_URL=${this.dockerReachableDatabaseUrl(envDbUrls.databaseUrl)}`);
        }
        if (envDbUrls.shadowDatabaseUrl) {
            dockerEnvOverrides.push('-e', `SHADOW_DATABASE_URL=${this.dockerReachableDatabaseUrl(envDbUrls.shadowDatabaseUrl)}`);
        }

        const args = [
            'run',
            '-d',
            '--name', name,
            '--restart', 'unless-stopped',
            // Loopback-only publish, exactly like the process-based runtime's HOST binding -
            // the container is never reachable from outside this machine directly.
            '-p', `${boundHost}:${platform.generatedPort}:${GENERATED_BACKEND_CONTAINER_PORT}`,
            '--network', network,
            // Makes `host.docker.internal` resolve to the Docker host on Linux too (already
            // built in on Docker Desktop for Mac/Windows, where this flag is a harmless no-op) -
            // required for dockerReachableDatabaseUrl()'s rewritten DATABASE_URL to actually
            // connect when the database lives on the orchestrator's own host machine.
            '--add-host', 'host.docker.internal:host-gateway',
            '--memory', memoryLimit,
            '--cpus', cpuLimit,
            '--read-only',
            '--tmpfs', '/tmp:rw,size=64m',
            // Docker's `--read-only` only applies to the container's own filesystem layers -
            // an explicitly bind-mounted path stays writable regardless, which is exactly what
            // UploadsController needs without weakening the read-only guarantee for everything else.
            '-v', `${uploadsHostDir}:/app/uploads:rw`,
            '--security-opt', 'no-new-privileges',
            '--env-file', path.join(projectPath, '.env'),
            // PORT/HOST inside the container are always fixed - see GENERATED_BACKEND_CONTAINER_PORT
            // - so they are deliberately NOT taken from the (per-platform, host-port-scoped) .env
            // file. Same defense-in-depth reasoning as RuntimeManagerService.buildChildEnv().
            '-e', `PORT=${GENERATED_BACKEND_CONTAINER_PORT}`,
            '-e', 'HOST=0.0.0.0', // bind-all is safe HERE: the container's network is only reachable via the host-side -p mapping above, which is already loopback-scoped.
            '-e', 'UPLOADS_DIR=/app/uploads', // matches the -v mount above, explicit rather than relying on the WORKDIR-relative default in uploadsMulterConfigTemplate().
            ...dockerEnvOverrides,
            this.imageTag(platform.slug),
        ];

        await this.runDockerCommand(args, platformId);

        await this.prisma.platform.update({
            where: { id: platformId },
            data: { runtimeStatus: 'STARTING', runtimePid: null, runtimeStartedAt: new Date() },
        });
        this.platformGateway.invalidate(platform.slug);

        this.logger.log(`Started generated backend container "${name}" for "${platform.slug}" (bound to ${boundHost}:${platform.generatedPort})`);
        return { message: 'Starting container…', container: name };
    }

    async stop(platformId: string) {
        const platform = await this.prisma.platform.findUniqueOrThrow({ where: { id: platformId } });
        const name = this.containerName(platform.slug);

        const running = await this.isContainerRunning(name);
        if (!running) {
            await this.prisma.platform.update({
                where: { id: platformId },
                data: { runtimeStatus: 'STOPPED', runtimePid: null },
            });
            this.platformGateway.invalidate(platform.slug);
            throw new BadRequestException('This backend is not currently running.');
        }

        await this.runDockerCommand(['stop', '-t', '10', name], platformId, { ignoreFailure: true });
        await this.runDockerCommand(['rm', '-f', name], platformId, { ignoreFailure: true });

        await this.prisma.platform.update({
            where: { id: platformId },
            data: { runtimeStatus: 'STOPPED', runtimePid: null },
        });
        this.platformGateway.invalidate(platform.slug);

        return { message: 'Container stopped successfully.' };
    }

    async getStatus(platformId: string) {
        const platform = await this.prisma.platform.findUniqueOrThrow({ where: { id: platformId } });
        let status = await this.getLiveStatus(platform.slug, platform.runtimeStatus);

        // BUGFIX: same issue as RuntimeManagerService.getStatus() - pinging only once already
        // RUNNING means `pingHealth()` (the only thing that ever flips STARTING -> RUNNING in
        // the database) never actually runs, so a freshly-started container stays STARTING
        // forever regardless of how healthy it is. See that file's comment for the full
        // explanation.
        let healthy = false;
        if ((status === 'RUNNING' || status === 'STARTING') && platform.generatedPort) {
            healthy = await this.pingHealth(platform.generatedPort);
            if (status === 'STARTING' && healthy) {
                status = 'RUNNING';
            }
        }

        return {
            status,
            // Containers have no host-visible PID the frontend needs - `pid` is kept for shape
            // parity with `RuntimeManagerService.getStatus()` (see `RuntimeStatusResponse` in
            // the frontend's `lib/api/relations.ts`), so switching runtimes never breaks the
            // Runtime tab's type expectations.
            pid: null,
            container: this.containerName(platform.slug),
            startedAt: platform.runtimeStartedAt,
            port: platform.generatedPort,
            healthy,
        };
    }

    async getLogs(platformId: string, tailLines = 200) {
        const platform = await this.prisma.platform.findUniqueOrThrow({ where: { id: platformId } });
        const name = this.containerName(platform.slug);
        try {
            const logs = await this.runDockerCommand(['logs', '--tail', String(tailLines), name], platformId, { capture: true, ignoreFailure: true });
            return { logs: logs ?? '' };
        } catch {
            return { logs: '' };
        }
    }

    // ---- Helpers ----

    private async getLiveStatus(
        slug: string,
        storedStatus: string,
    ): Promise<'STOPPED' | 'STARTING' | 'RUNNING' | 'CRASHED'> {
        const name = this.containerName(slug);
        const running = await this.isContainerRunning(name);

        if (!running && (storedStatus === 'RUNNING' || storedStatus === 'STARTING')) {
            return 'CRASHED';
        }
        if (running && storedStatus === 'STARTING') {
            return 'STARTING';
        }
        if (!running) {
            return 'STOPPED';
        }
        return storedStatus as 'STOPPED' | 'RUNNING' | 'CRASHED';
    }

    private async isContainerRunning(name: string): Promise<boolean> {
        try {
            const output = await this.runDockerCommand(
                ['inspect', '-f', '{{.State.Running}}', name],
                undefined,
                { capture: true, ignoreFailure: true },
            );
            return output?.trim() === 'true';
        } catch {
            return false;
        }
    }

    private async pingHealth(port: number): Promise<boolean> {
        try {
            const res = await fetch(`http://localhost:${port}/${GENERATED_BACKEND_API_PREFIX}/health`, { signal: AbortSignal.timeout(2000) });
            if (!res.ok) return false;
            const body = await res.json();
            if (body.status === 'ok') {
                const platform = await this.prisma.platform.findFirst({ where: { generatedPort: port } });
                if (platform) {
                    const updated = await this.prisma.platform.updateMany({
                        where: { id: platform.id, runtimeStatus: 'STARTING' },
                        data: { runtimeStatus: 'RUNNING' },
                    });
                    if (updated.count > 0) {
                        this.platformGateway.invalidate(platform.slug);
                    }
                }
            }
            return body.status === 'ok';
        } catch {
            return false;
        }
    }

    private resolveProjectPath(slug: string): string {
        const root = this.configService.get<string>('GENERATED_PROJECTS_ROOT', 'generated');
        const absoluteRoot = path.isAbsolute(root) ? root : path.resolve(process.cwd(), root);
        return path.join(absoluteRoot, slug, 'backend');
    }

    /**
     * Runs a `docker` CLI subcommand. By default only surfaces success/failure (throwing on a
     * non-zero exit code); pass `capture: true` to also collect and return stdout (used for
     * `docker logs` / `docker inspect`). `ignoreFailure: true` resolves instead of throwing on a
     * non-zero exit, for commands whose failure is an expected/handled outcome (e.g. `docker rm`
     * on a container that may not exist).
     */
    private runDockerCommand(
        args: string[],
        platformId: string | undefined,
        opts: { capture?: boolean; ignoreFailure?: boolean } = {},
    ): Promise<string | undefined> {
        return new Promise((resolve, reject) => {
            const child = spawn('docker', args);
            let stdout = '';
            let stderr = '';
            child.stdout?.on('data', (d) => { stdout += d.toString(); });
            child.stderr?.on('data', (d) => { stderr += d.toString(); });
            child.on('error', (err) => {
                if (opts.ignoreFailure) return resolve(undefined);
                reject(err);
            });
            child.on('close', (code) => {
                if (code === 0) {
                    resolve(opts.capture ? stdout : undefined);
                    return;
                }
                if (opts.ignoreFailure) {
                    resolve(undefined);
                    return;
                }
                this.logger.error(`docker ${args.join(' ')} failed (exit ${code})${platformId ? ` [platform=${platformId}]` : ''}: ${stderr.trim()}`);
                reject(new BadRequestException(`Docker command failed: ${stderr.trim() || `exit code ${code}`}`));
            });
        });
    }
}