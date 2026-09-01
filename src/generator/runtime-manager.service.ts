import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformGatewayService } from '../gateway/platform-gateway.service';
import { GENERATED_BACKEND_API_PREFIX } from './generated-backend.constants';

const MAX_LOG_FILE_BYTES = 2 * 1024 * 1024; // 2MB log file size limit

/**
 * Environment variables from THIS (orchestrator) process that a generated backend's child
 * process is allowed to inherit. Everything else is deliberately left out - see the comment on
 * `buildChildEnv()` for why an unfiltered `...process.env` spread is both the root cause of the
 * PORT bug this fixes and a secret-leak/isolation problem in its own right.
 */
const INHERITED_ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'TZ', 'TMPDIR'] as const;

@Injectable()
export class RuntimeManagerService {
    private readonly logger = new Logger(RuntimeManagerService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly configService: ConfigService,
        private readonly platformGateway: PlatformGatewayService,
    ) {}

    /**
     * Builds the environment passed to a generated backend's child process.
     *
     * BUGFIX (generated backend listening on the orchestrator's own port): this used to be
     * `{ ...process.env, HOST: boundHost }` - spreading the ENTIRE orchestrator environment
     * into the child and only overriding `HOST`. Two things went wrong because of that:
     *
     *   1. This orchestrator process itself listens on `PORT` (default `4803`, see the root
     *      `main.ts`). Spreading `process.env` handed that same `PORT=4803` to every generated
     *      child. The generated `main.ts` used to load its `.env` with plain `dotenv/config`,
     *      which by default does NOT override a variable already present in `process.env` - so
     *      the inherited orchestrator `PORT` silently won over the correct, platform-specific
     *      port written to the generated project's own `.env` by `envTemplate()`. That is
     *      exactly the "always 4803, but the generated `.env` says otherwise" symptom.
     *   2. Independently of the PORT bug: spreading the full orchestrator environment also
     *      leaks every secret this process holds (its own `DATABASE_URL`, JWT signing secret,
     *      SMTP credentials, etc.) into a child process running arbitrary, per-platform
     *      generated code. A generated backend has no legitimate reason to see any of that.
     *
     * The fix has two independent layers (defense in depth, so neither has to be perfect alone):
     *   - Here: build an explicit, minimal environment. Only a small allowlist of harmless
     *     process-level variables is inherited (`INHERITED_ENV_ALLOWLIST`); everything the
     *     generated backend actually needs (`PORT`, `HOST`, `DATABASE_URL`, `NODE_ENV`, ...) is
     *     set explicitly from data this service already knows to be correct for THIS platform.
     *   - `mainTsTemplate()`: the generated `main.ts` now loads its own `.env` with
     *     `{ override: true }`, so even if something upstream of this method ever leaks an
     *     unrelated `PORT` again, the generated project's own `.env` file wins.
     */
    private buildChildEnv(platform: { generatedPort: number | null }, boundHost: string): NodeJS.ProcessEnv {
        if (!platform.generatedPort) {
            throw new BadRequestException('This platform has no allocated port yet.');
        }

        const env: NodeJS.ProcessEnv = {};
        for (const key of INHERITED_ENV_ALLOWLIST) {
            if (process.env[key] !== undefined) env[key] = process.env[key];
        }

        return {
            ...env,
            // Explicit, not inherited: this is the one and only source of truth for which port
            // and host THIS platform's backend must bind to.
            PORT: String(platform.generatedPort),
            HOST: boundHost,
            NODE_ENV: this.configService.get<string>('NODE_ENV', 'production'),
        };
    }

    /**
     * Spawns an isolated background Node.js process for a generated platform backend.
     * Educational Note: Uses Node.js `child_process.spawn` with `detached: true` and `child.unref()`
     * to allow the target backend process to run independently of the host orchestrator process lifecycle.
     *
     * SECURITY: the child process is explicitly given `HOST=127.0.0.1` (or whatever
     * `GENERATED_BACKEND_HOST` is configured to) and its own `PORT` in its environment,
     * regardless of what the generated project's own `.env` file says or what this orchestrator
     * process's own environment happens to contain - see `buildChildEnv()`. Belt and suspenders:
     * the generated backend must never accidentally bind to a public interface, and must never
     * accidentally bind to the orchestrator's own port.
     */
    async start(platformId: string) {
        const platform = await this.prisma.platform.findUniqueOrThrow({ where: { id: platformId } });

        if (platform.status !== 'ACTIVE') {
            throw new BadRequestException('Generate this platform successfully at least once before starting it.');
        }

        const liveStatus = await this.getLiveStatus(platform.id, platform.runtimePid, platform.runtimeStatus);
        if (liveStatus === 'RUNNING' || liveStatus === 'STARTING') {
            throw new BadRequestException('This backend is already running.');
        }

        const projectPath = this.resolveProjectPath(platform.slug);
        const entryFile = path.join(projectPath, 'dist', 'src', 'main.js');
        if (!fs.existsSync(entryFile)) {
            throw new BadRequestException('No build artifact found. Execute a generation process first.');
        }

        const logPath = this.resolveLogPath(projectPath);
        await this.trimLogIfNeeded(logPath);
        const logFd = fs.openSync(logPath, 'a');

        const boundHost = this.configService.get<string>('GENERATED_BACKEND_HOST', '127.0.0.1');
        const childEnv = this.buildChildEnv(platform, boundHost);

        // Spawn detached process directing stdout and stderr streams to execution log file descriptor
        const child = spawn('node', ['dist/src/main.js'], {
            cwd: projectPath,
            detached: true,
            stdio: ['ignore', logFd, logFd],
            env: childEnv,
        });
        child.unref();
        fs.closeSync(logFd);

        await this.prisma.platform.update({
            where: { id: platformId },
            data: { runtimeStatus: 'STARTING', runtimePid: child.pid, runtimeStartedAt: new Date() },
        });

        // The gateway caches slug -> {port, status} lookups for a few seconds to avoid a
        // database round-trip on every single proxied request. Invalidate that cache
        // immediately so the very next proxied request re-reads fresh state instead of
        // waiting out the cache TTL.
        this.platformGateway.invalidate(platform.slug);

        this.logger.log(`Started generated backend process for "${platform.slug}" (PID: ${child.pid}, bound to ${boundHost})`);
        return { message: 'Starting process…', pid: child.pid };
    }

    /**
     * Gracefully stops a running backend process, falling back to forceful kill if unresponsive.
     * Educational Note: Sends a polite `SIGTERM` signal first to allow clean process termination,
     * following up with a coercive `SIGKILL` if the process fails to exit within the grace period.
     */
    async stop(platformId: string) {
        const platform = await this.prisma.platform.findUniqueOrThrow({ where: { id: platformId } });

        if (!platform.runtimePid || !this.isProcessAlive(platform.runtimePid)) {
            await this.prisma.platform.update({
                where: { id: platformId },
                data: { runtimeStatus: 'STOPPED', runtimePid: null },
            });
            this.platformGateway.invalidate(platform.slug);
            throw new BadRequestException('This backend is not currently running.');
        }

        try {
            process.kill(platform.runtimePid, 'SIGTERM');
        } catch {
            // Process already terminated
        }

        await new Promise((resolve) => setTimeout(resolve, 2000));

        if (this.isProcessAlive(platform.runtimePid)) {
            try {
                process.kill(platform.runtimePid, 'SIGKILL');
            } catch {
                /* Ignore force kill errors */
            }
        }

        await this.prisma.platform.update({
            where: { id: platformId },
            data: { runtimeStatus: 'STOPPED', runtimePid: null },
        });

        // Ensure the gateway immediately stops proxying to a port that no longer has a
        // listener behind it, instead of waiting for the short-lived cache entry to expire.
        this.platformGateway.invalidate(platform.slug);

        return { message: 'Process stopped successfully.' };
    }

    /**
     * Returns process state, port configuration, and active HTTP health ping status.
     */
    async getStatus(platformId: string) {
        const platform = await this.prisma.platform.findUniqueOrThrow({ where: { id: platformId } });
        let status = await this.getLiveStatus(platform.id, platform.runtimePid, platform.runtimeStatus);

        // BUGFIX: this used to only ping when `status === 'RUNNING'` - but `pingHealth()` is the
        // ONLY code path that ever flips a platform from STARTING to RUNNING in the database
        // (see its `updateMany(... runtimeStatus: 'STARTING' -> 'RUNNING')` below). Gating the
        // ping behind "already RUNNING" meant it could never actually run for a platform that
        // just started - `status` would stay STARTING forever, no matter how healthy the
        // process actually was, and the gateway (which only routes to RUNNING platforms) would
        // 404 every request indefinitely. Now pinged whenever STARTING too, and `status` is
        // re-read from the (possibly just-updated) live state so the response reflects the
        // flip within this same call instead of requiring one extra poll cycle.
        let healthy = false;
        if ((status === 'RUNNING' || status === 'STARTING') && platform.generatedPort) {
            healthy = await this.pingHealth(platform.generatedPort);
            if (status === 'STARTING' && healthy) {
                status = 'RUNNING';
            }
        }

        return {
            status,
            pid: platform.runtimePid,
            startedAt: platform.runtimeStartedAt,
            port: platform.generatedPort,
            healthy,
        };
    }

    /**
     * Reads recent tail lines from the runtime log file.
     */
    async getLogs(platformId: string, tailLines = 200) {
        const platform = await this.prisma.platform.findUniqueOrThrow({ where: { id: platformId } });
        const projectPath = this.resolveProjectPath(platform.slug);
        const logPath = this.resolveLogPath(projectPath);

        try {
            const content = await fsp.readFile(logPath, 'utf-8');
            const lines = content.split('\n');
            return { logs: lines.slice(-tailLines).join('\n') };
        } catch {
            return { logs: '' };
        }
    }

    // ---- Helpers ----

    /**
     * Checks process viability and reconciles database state if the child process exited unexpectedly.
     */
    private async getLiveStatus(
        platformId: string,
        pid: number | null,
        storedStatus: string,
    ): Promise<'STOPPED' | 'STARTING' | 'RUNNING' | 'CRASHED'> {
        if (!pid) return 'STOPPED';
        const alive = this.isProcessAlive(pid);

        if (!alive && (storedStatus === 'RUNNING' || storedStatus === 'STARTING')) {
            await this.prisma.platform.update({
                where: { id: platformId },
                data: { runtimeStatus: 'CRASHED', runtimePid: null },
            });
            return 'CRASHED';
        }

        if (alive && storedStatus === 'STARTING') {
            // Maintains "STARTING" state until confirmed via health endpoint ping
            return 'STARTING';
        }

        return storedStatus as 'STOPPED' | 'RUNNING' | 'CRASHED';
    }

    /**
     * Tests if a process PID is alive without sending a destructive termination signal.
     * Educational Note: `process.kill(pid, 0)` is a POSIX trick that performs signal accessibility 
     * and existence checks without sending an actual signal to the process.
     */
    private isProcessAlive(pid: number): boolean {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Sends an HTTP ping to verify service availability and transitions `STARTING` status to `RUNNING`.
     */
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
                    // Only invalidate when we actually flipped STARTING -> RUNNING, so the
                    // gateway's short cache TTL picks up the new "routable" state immediately
                    // instead of waiting a few seconds for it to expire naturally.
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

    /**
     * Truncates log file size if it exceeds maximum threshold to prevent disk exhaustion.
     */
    private async trimLogIfNeeded(logPath: string) {
        try {
            const stat = await fsp.stat(logPath);
            if (stat.size > MAX_LOG_FILE_BYTES) {
                const content = await fsp.readFile(logPath, 'utf-8');
                await fsp.writeFile(logPath, content.slice(-MAX_LOG_FILE_BYTES / 2));
            }
        } catch {
            /* File does not exist yet; no trimming required */
        }
    }

    private resolveProjectPath(slug: string): string {
        const root = this.configService.get<string>('GENERATED_PROJECTS_ROOT', 'generated');
        const absoluteRoot = path.isAbsolute(root) ? root : path.resolve(process.cwd(), root);
        return path.join(absoluteRoot, slug, 'backend');
    }

    private resolveLogPath(projectPath: string): string {
        return path.join(projectPath, 'run.log');
    }
}