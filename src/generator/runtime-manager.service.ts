import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';

const MAX_LOG_FILE_BYTES = 2 * 1024 * 1024; // 2MB log file size limit

@Injectable()
export class RuntimeManagerService {
    private readonly logger = new Logger(RuntimeManagerService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly configService: ConfigService,
    ) {}

    /**
     * Spawns an isolated background Node.js process for a generated platform backend.
     * Educational Note: Uses Node.js `child_process.spawn` with `detached: true` and `child.unref()`
     * to allow the target backend process to run independently of the host orchestrator process lifecycle.
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
        const entryFile = path.join(projectPath, 'dist', 'main.js');
        if (!fs.existsSync(entryFile)) {
            throw new BadRequestException('No build artifact found. Execute a generation process first.');
        }

        const logPath = this.resolveLogPath(projectPath);
        await this.trimLogIfNeeded(logPath);
        const logFd = fs.openSync(logPath, 'a');

        // Spawn detached process directing stdout and stderr streams to execution log file descriptor
        const child = spawn('node', ['dist/main.js'], {
            cwd: projectPath,
            detached: true,
            stdio: ['ignore', logFd, logFd],
        });
        child.unref();
        fs.closeSync(logFd);

        await this.prisma.platform.update({
            where: { id: platformId },
            data: { runtimeStatus: 'STARTING', runtimePid: child.pid, runtimeStartedAt: new Date() },
        });

        this.logger.log(`Started generated backend process for "${platform.slug}" (PID: ${child.pid})`);
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

        return { message: 'Process stopped successfully.' };
    }

    /**
     * Returns process state, port configuration, and active HTTP health ping status.
     */
    async getStatus(platformId: string) {
        const platform = await this.prisma.platform.findUniqueOrThrow({ where: { id: platformId } });
        const status = await this.getLiveStatus(platform.id, platform.runtimePid, platform.runtimeStatus);

        let healthy = false;
        if (status === 'RUNNING' && platform.generatedPort) {
            healthy = await this.pingHealth(platform.generatedPort);
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
            const res = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
            if (!res.ok) return false;

            const body = await res.json();
            if (body.status === 'ok') {
                const platformId = await this.findPlatformIdByPort(port);
                if (platformId) {
                    await this.prisma.platform.updateMany({
                        where: { id: platformId, runtimeStatus: 'STARTING' },
                        data: { runtimeStatus: 'RUNNING' },
                    });
                }
            }
            return body.status === 'ok';
        } catch {
            return false;
        }
    }

    private async findPlatformIdByPort(port: number): Promise<string | null> {
        const platform = await this.prisma.platform.findFirst({ where: { generatedPort: port } });
        return platform?.id ?? null;
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