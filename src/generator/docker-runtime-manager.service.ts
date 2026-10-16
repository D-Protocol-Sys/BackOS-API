import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformGatewayService } from '../gateway/platform-gateway.service';
import { GENERATED_BACKEND_API_PREFIX, GENERATED_BACKEND_CONTAINER_PORT } from './generated-backend.constants';
import { redactSecrets } from '../common/utils/command-runner.util';

const DOCKER_COMMAND_TIMEOUT_MS = 60_000;
const DOCKER_BUILD_TIMEOUT_MS = 15 * 60_000;
const MAX_CAPTURED_OUTPUT = 2 * 1024 * 1024;

/**
 * Docker-based runtime manager (formerly a drop-in alternative to the removed native-process runtime; same public method shapes: `start`, `stop`,
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
 * This is THE runtime implementation: every runtime route (GeneratorController), the
 * generation pipeline and the platform purge use it. (The former native-process
 * RuntimeManagerService was never routed to and has been removed - ARCH-005.)
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
        await this.runDockerCommand(['network', 'create', '--driver', 'bridge', networkName], undefined, {
            ignoreFailure: true,
        });
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
        // The DB is attached under its CONTAINER name only, but the generated project's DATABASE_URL
        // may carry a different hostname (e.g. the Compose service name `postgres`, from
        // PROVISION_HOST) - that alias only exists on the orchestrator's own Compose network, not on
        // this per-platform one. Registering GENERATED_BACKEND_DOCKER_DB_HOST as a network-scoped
        // alias makes that hostname resolvable here too. (Networks created by an earlier version
        // keep their old attachment: recreate the network once - `docker network rm <name>` after
        // stopping the platform - to pick the alias up.)
        const dbAlias = this.configService.get<string>('GENERATED_BACKEND_DOCKER_DB_HOST');
        const aliasArgs =
            dbAlias && dbAlias !== 'host.docker.internal' && dbAlias !== dbContainerName ? ['--alias', dbAlias] : [];
        await this.runDockerCommand(['network', 'connect', ...aliasArgs, networkName, dbContainerName], undefined, {
            ignoreFailure: true,
        });
    }

    /**
     * BUGFIX (generated backend unreachable ONLY under Docker, works fine under
     * `DockerRuntimeManagerService`): `envTemplate()` writes `DATABASE_URL`/`SHADOW_DATABASE_URL` into
     * the generated project's `.env` using `database.provisioningHost`, which defaults to
     * `localhost` - correct for `DockerRuntimeManagerService`, whose child process shares the
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
    /**
     * Parses the generated project's `.env` (written by `envTemplate()`, where values needing
     * quotes are JSON-encoded) into plain key/value pairs.
     */
    private async readProjectEnv(projectPath: string): Promise<Record<string, string>> {
        const content = await fsp.readFile(path.join(projectPath, '.env'), 'utf-8');
        const env: Record<string, string> = {};
        for (const rawLine of content.split('\n')) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;
            const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
            if (!match) continue;
            let value = match[2];
            if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
                try {
                    value = JSON.parse(value);
                } catch {
                    value = value.slice(1, -1);
                }
            }
            if (/[\r\n]/.test(value)) {
                this.logger.warn(
                    `Skipping multi-line environment value "${match[1]}" (unsupported by Docker env files).`,
                );
                continue;
            }
            env[match[1]] = value;
        }
        return env;
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
    private async buildImage(
        platformId: string,
        slug: string,
        projectPath: string,
        schemaVersion: number,
    ): Promise<void> {
        const tag = this.imageTag(slug);
        // PERF FIX (RT-001): the image used to be rebuilt on every start, synchronously inside the
        // HTTP request. It is now rebuilt only when missing or built from an older generation
        // (schema version label). `buildImageForGeneration()` also pre-builds it right after a
        // successful generation.
        const builtVersion = await this.runDockerCommand(
            ['image', 'inspect', '-f', '{{ index .Config.Labels "backos.schema-version" }}', tag],
            undefined,
            { capture: true, ignoreFailure: true },
        );
        if (builtVersion?.trim() === String(schemaVersion)) return;

        await this.runDockerCommand(
            ['build', '--label', `backos.schema-version=${schemaVersion}`, '-t', tag, projectPath],
            platformId,
            { timeoutMs: DOCKER_BUILD_TIMEOUT_MS },
        );
    }

    /** Pre-builds the image of a freshly generated platform (called by the generation pipeline). */
    async buildImageForGeneration(platformId: string, slug: string, schemaVersion: number): Promise<void> {
        await this.buildImage(platformId, slug, this.resolveProjectPath(slug), schemaVersion);
    }

    /**
     * Polls `docker inspect` until `name` genuinely no longer exists (rather than trusting
     * `docker rm -f`'s exit code alone) - see the call site in `start()` for why this closes a
     * real "Conflict: name already in use" race against the very next `docker run`.
     */
    private async waitForContainerRemoval(name: string, attempts = 10, delayMs = 300): Promise<void> {
        for (let i = 0; i < attempts; i++) {
            const stillThere = await this.runDockerCommand(['inspect', '--format', '{{.Id}}', name], undefined, {
                capture: true,
                ignoreFailure: true,
            });
            if (!stillThere) return; // `docker inspect` failed - the name is free.
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        this.logger.warn(
            `Container "${name}" still present after removal wait - proceeding anyway, the next docker run may race it.`,
        );
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
        await this.buildImage(platformId, platform.slug, projectPath, platform.schemaVersion);

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
        const apiDocsEnabled = this.isApiDocsEnabled();

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
        //
        // GENERATED_BACKEND_UPLOADS_USE_VOLUME=true swaps the bind mount for a Docker NAMED volume
        // (`<container>-uploads`). Needed when the orchestrator itself runs in a container without
        // a host-path-identical mount (e.g. the Windows/LAN stack, where `generated_projects` is a
        // named volume): the `-v <path>` source is resolved by the DOCKER DAEMON, not by this
        // process, so a container-internal path would silently become a fresh root-owned directory
        // on the daemon's side and every upload would fail with a permission error. A named volume
        // has no host path at all, and is initialised with the ownership of `/app/uploads` in the
        // image (see dockerfileTemplate()).
        const useUploadsVolume =
            String(this.configService.get<string | boolean>('GENERATED_BACKEND_UPLOADS_USE_VOLUME', false)) === 'true';
        const uploadsHostDir = path.join(projectPath, 'uploads');
        if (!useUploadsVolume) await fsp.mkdir(uploadsHostDir, { recursive: true });
        // Bind mounts keep the HOST directory's ownership/permissions inside the container -
        // the image's non-root `app` user (see dockerfileTemplate()) has no guarantee its UID
        // matches whatever created this directory on the host, so without this the container
        // could get a permission-denied error on every upload despite the mount being `rw`.
        // The directory only ever holds already-validated, randomly-named uploads served back
        // read-only by everyone except this container, so the broadened permission is low-risk.
        if (!useUploadsVolume) await fsp.chmod(uploadsHostDir, 0o777);

        // BUGFIX: see dockerReachableDatabaseUrl() - the .env file's DATABASE_URL/SHADOW_DATABASE_URL
        // point at `localhost`, which is only correct for DockerRuntimeManagerService's host-spawned
        // process, not for this container. Rewritten here and passed as explicit `-e` overrides
        // below (same pattern as the existing PORT/HOST overrides).
        // RELIABILITY FIX (GEN-008): the project's `.env` quotes some values (JSON-style), but
        // `docker --env-file` takes values literally - quotes included - so secrets containing
        // special characters reached the container altered. The file is parsed here and
        // rewritten in Docker's own literal format into a short-lived, owner-only file.
        const containerEnv = await this.readProjectEnv(projectPath);
        delete containerEnv.SHADOW_DATABASE_URL; // never needed at runtime
        if (containerEnv.DATABASE_URL) {
            containerEnv.DATABASE_URL = this.dockerReachableDatabaseUrl(containerEnv.DATABASE_URL);
        }
        Object.assign(containerEnv, {
            PORT: String(GENERATED_BACKEND_CONTAINER_PORT),
            HOST: '0.0.0.0',
            API_DOCS_ENABLED: String(apiDocsEnabled),
            UPLOADS_DIR: '/app/uploads',
        });
        const dockerEnvFile = path.join(projectPath, '.env.docker');
        await fsp.writeFile(
            dockerEnvFile,
            Object.entries(containerEnv)
                .map(([key, value]) => `${key}=${value}`)
                .join('\n') + '\n',
            { encoding: 'utf-8', mode: 0o600 },
        );

        const args = [
            'run',
            '-d',
            '--name',
            name,
            // RT-002: bounded restarts instead of an infinite crash loop.
            '--restart',
            'on-failure:5',
            // Loopback-only publish: the container is never reachable from outside this machine directly.
            '-p',
            `${boundHost}:${platform.generatedPort}:${GENERATED_BACKEND_CONTAINER_PORT}`,
            '--network',
            network,
            '--add-host',
            'host.docker.internal:host-gateway',
            '--memory',
            memoryLimit,
            '--cpus',
            cpuLimit,
            // RT-002: hardening - no Linux capabilities, bounded process count and log size.
            '--pids-limit',
            '256',
            '--cap-drop',
            'ALL',
            '--log-opt',
            'max-size=10m',
            '--log-opt',
            'max-file=3',
            '--read-only',
            '--tmpfs',
            '/tmp:rw,size=64m',
            '-v',
            `${useUploadsVolume ? `${name}-uploads` : uploadsHostDir}:/app/uploads:rw`,
            '--security-opt',
            'no-new-privileges',
            '--env-file',
            dockerEnvFile,
            this.imageTag(platform.slug),
        ];

        try {
            await this.runDockerCommand(args, platformId);
        } finally {
            await fsp.rm(dockerEnvFile, { force: true });
        }

        await this.prisma.platform.update({
            where: { id: platformId },
            data: { runtimeStatus: 'STARTING', runtimePid: null, runtimeStartedAt: new Date() },
        });
        this.platformGateway.invalidate(platform.slug);

        this.logger.log(
            `Started generated backend container "${name}" for "${platform.slug}" (bound to ${boundHost}:${platform.generatedPort})`,
        );
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

    /**
     * Whether generated backends should serve their interactive Swagger docs. The image is always
     * NODE_ENV=production, so the generated main.ts cannot infer this itself - it is passed in as
     * API_DOCS_ENABLED at container start (see the comment in mainTsTemplate()). Explicit
     * `GENERATED_BACKEND_API_DOCS_ENABLED` wins; otherwise docs are off in production, on elsewhere.
     * `getStatus()` reports the same value so the frontend can grey out "Open API docs" instead of
     * sending the user to a JSON 404.
     */
    private isApiDocsEnabled(): boolean {
        const flag = this.configService.get<string | boolean>('GENERATED_BACKEND_API_DOCS_ENABLED');
        if (flag === undefined || flag === '') return this.configService.get<string>('NODE_ENV') !== 'production';
        return String(flag) === 'true';
    }

    async getStatus(platformId: string) {
        const platform = await this.prisma.platform.findUniqueOrThrow({ where: { id: platformId } });
        let status = await this.getLiveStatus(platform.slug, platform.runtimeStatus);

        // BUGFIX: same issue as DockerRuntimeManagerService.getStatus() - pinging only once already
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
            // parity with `DockerRuntimeManagerService.getStatus()` (see `RuntimeStatusResponse` in
            // the frontend's `lib/api/relations.ts`), so switching runtimes never breaks the
            // Runtime tab's type expectations.
            pid: null,
            container: this.containerName(platform.slug),
            startedAt: platform.runtimeStartedAt,
            port: platform.generatedPort,
            healthy,
            docsEnabled: this.isApiDocsEnabled(),
        };
    }

    async getLogs(platformId: string, tailLines = 200) {
        tailLines = Math.max(1, Math.min(Math.floor(tailLines) || 200, 2000));
        const platform = await this.prisma.platform.findUniqueOrThrow({ where: { id: platformId } });
        const name = this.containerName(platform.slug);
        try {
            const logs = await this.runDockerCommand(['logs', '--tail', String(tailLines), name], platformId, {
                capture: true,
                ignoreFailure: true,
            });
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
            const output = await this.runDockerCommand(['inspect', '-f', '{{.State.Running}}', name], undefined, {
                capture: true,
                ignoreFailure: true,
            });
            return output?.trim() === 'true';
        } catch {
            return false;
        }
    }

    private async pingHealth(port: number): Promise<boolean> {
        try {
            // Same address the gateway uses to reach the backend (see GENERATED_BACKEND_GATEWAY_HOST).
            const host = this.configService.get<string>('GENERATED_BACKEND_GATEWAY_HOST') || 'localhost';
            const res = await fetch(`http://${host}:${port}/${GENERATED_BACKEND_API_PREFIX}/health`, {
                signal: AbortSignal.timeout(2000),
            });
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
        opts: { capture?: boolean; ignoreFailure?: boolean; timeoutMs?: number } = {},
    ): Promise<string | undefined> {
        // RELIABILITY FIX (RT-001): every docker call is bounded in time (a hung daemon or build
        // used to block the request forever) and in captured output (`docker logs` of a chatty
        // container used to be buffered entirely in memory).
        const timeoutMs = opts.timeoutMs ?? DOCKER_COMMAND_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
            const child = spawn('docker', args);
            let stdout = '';
            let stderr = '';
            const append = (current: string, chunk: Buffer) => {
                const next = current + chunk.toString();
                return next.length > MAX_CAPTURED_OUTPUT ? next.slice(-MAX_CAPTURED_OUTPUT) : next;
            };
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
            }, timeoutMs);
            timer.unref();

            child.stdout?.on('data', (d: Buffer) => {
                stdout = append(stdout, d);
            });
            child.stderr?.on('data', (d: Buffer) => {
                stderr = append(stderr, d);
            });
            child.on('error', (err) => {
                clearTimeout(timer);
                if (opts.ignoreFailure) return resolve(undefined);
                reject(err);
            });
            child.on('close', (code, signal) => {
                clearTimeout(timer);
                if (code === 0) {
                    resolve(opts.capture ? stdout : undefined);
                    return;
                }
                if (opts.ignoreFailure) {
                    resolve(undefined);
                    return;
                }
                const reason = signal === 'SIGKILL' ? `timed out after ${timeoutMs} ms` : `exit ${code}`;
                this.logger.error(
                    `docker ${args[0]} failed (${reason})${platformId ? ` [platform=${platformId}]` : ''}: ${redactSecrets(stderr.trim())}`,
                );
                reject(new BadRequestException(`Docker command failed: ${redactSecrets(stderr.trim()) || reason}`));
            });
        });
    }
}
