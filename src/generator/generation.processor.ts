import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { GENERATION_QUEUE_NAME } from './generator-queue.module';
import { PrismaService } from '../prisma/prisma.service';
import { ProvisioningService } from './provisioning.service';
import { ProjectScaffolderService } from './project-scaffolder.service';
import { GenerationsService } from './generations.service';
import { runCommand, CommandFailedError } from '../common/utils/command-runner.util';
import { PortAllocatorService } from './port-allocator.service';

/**
 * Data payload interface passed into BullMQ generation jobs.
 */
export interface GenerationJobData {
    platformId: string;
    slug: string;
    generationId: string;
}

/**
 * BullMQ background processor worker consuming platform build jobs.
 * * Orchestrates the full lifecycle of application generation:
 * 1. Database provisioning/reuse.
 * 2. Source code scaffolding and file writing.
 * 3. Dependency installation (`pnpm install`).
 * 4. Prisma client generation (`prisma generate`).
 * 5. Database migrations (`prisma migrate deploy`).
 * 6. Application compilation (`pnpm run build`).
 */
@Processor(GENERATION_QUEUE_NAME)
export class GenerationProcessor extends WorkerHost {
    private readonly logger = new Logger(GenerationProcessor.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly provisioning: ProvisioningService,
        private readonly scaffolder: ProjectScaffolderService,
        private readonly generations: GenerationsService,
        private readonly portAllocator: PortAllocatorService,
        private readonly configService: ConfigService,
    ) {
        super();
    }

    /**
     * Core processing method invoked automatically whenever a new build job is picked up from BullMQ queue.
     * * @param job - BullMQ Job container containing `GenerationJobData`.
     */
    async process(job: Job<GenerationJobData>): Promise<void> {
        const { platformId, slug, generationId } = job.data;

        // Command execution timeout setting (defaults to 5 minutes / 300,000ms)
        const timeoutMs = this.configService.get<number>(
            'GENERATION_COMMAND_TIMEOUT_MS',
            300_000,
        );

        // Transition generation state to running and platform status to GENERATING
        await this.generations.markRunning(generationId);

        await this.prisma.platform.update({
            where: { id: platformId },
            data: { status: 'GENERATING' },
        });

        try {
            /*
             * ============================================================
             * 1. DATABASE PROVISIONING
             * ============================================================
             */

            await this.log( generationId, '→ Checking database connection...' );
            let dbUrl: string;
            const existingDb = await this.prisma.platformDatabase.findUnique({
                where: { platformId },
            });
            if (existingDb) {
                dbUrl = await this.provisioning.getDecryptedConnectionUrl( platformId );
                await this.log( generationId, `  Existing database reused: ${existingDb.databaseName}` );
            } else {
                await this.log( generationId, '→ Provisioning database...' );
                const result = await this.provisioning.provisionDatabaseForPlatform(
                    platformId,
                    slug,
                );
                dbUrl = result.databaseUrl;
                await this.log( generationId, `  Database created: ${result.databaseName}` );
            }

            /*
             * ============================================================
             * 2. PROJECT SCAFFOLDING
             * ============================================================
             */

            await this.log( generationId, '→ Generating project files...' );
            const port = await this.portAllocator.getOrAllocatePort(platformId);
            const { projectPath } = await this.scaffolder.scaffold({
                platformId,
                slug,
                databaseUrl: dbUrl,
                port,
            });
            await this.log( generationId, `  Project written to ${projectPath} (port ${port})` );

            /*
             * ============================================================
             * 3. INSTALL DEPENDENCIES
             * ============================================================
             */

            await this.log( generationId, '→ Installing dependencies (pnpm install)...' );
            await this.runStep(
                generationId,
                'pnpm',
                ['install', '--frozen-lockfile'],
                projectPath,
                timeoutMs,
            );

            /*
             * ============================================================
             * 4. GENERATE PRISMA CLIENT
             * ============================================================
             */

            await this.log(
                generationId,
                '→ Generating Prisma client...',
            );

            await this.runStep(
                generationId,
                'pnpm',
                ['exec', 'prisma', 'generate'],
                projectPath,
                timeoutMs,
            );

            /*
             * ============================================================
             * 5. APPLY VERSIONED DATABASE MIGRATIONS
             * ============================================================
             *
             * IMPORTANT:
             *
             * This intentionally does NOT use:
             * `prisma db push --accept-data-loss`
             *
             * The generated project must contain a valid
             * prisma/migrations directory.
             *
             * `migrate deploy` is non-interactive and applies only
             * migrations already present in the project.
             */

            await this.log(
                generationId,
                '→ Applying Prisma migrations...',
            );

            await this.runStep(
                generationId,
                'pnpm',
                ['exec', 'prisma', 'migrate', 'deploy'],
                projectPath,
                timeoutMs,
            );

            /*
             * ============================================================
             * 6. BUILD GENERATED PROJECT
             * ============================================================
             */

            await this.log(
                generationId,
                '→ Compiling project (pnpm run build)...',
            );

            await this.runStep(
                generationId,
                'pnpm',
                ['run', 'build'],
                projectPath,
                timeoutMs,
            );

            /*
             * ============================================================
             * 7. GENERATION SUCCESS
             * ============================================================
             */

            await this.log(
                generationId,
                '✅ Generation completed successfully.',
            );

            await this.generations.markSuccess(generationId);

            await this.prisma.platform.update({
                where: { id: platformId },
                data: { status: 'ACTIVE' },
            });
        } catch (error: unknown) {
            const message =
                error instanceof Error
                    ? error.message
                    : String(error);

            this.logger.error(
                `Generation ${generationId} failed`,
                error instanceof Error
                    ? error.stack
                    : undefined,
            );

            /*
             * Logging failure information should never prevent
             * the generation from being marked as failed.
             */
            try {
                await this.log(
                    generationId,
                    `❌ Failure: ${message}`,
                );
            } catch (logError: unknown) {
                this.logger.error(
                    `Failed to record log for generation ${generationId}`,
                    logError instanceof Error
                        ? logError.stack
                        : String(logError),
                );
            }

            try {
                await this.generations.markFailed(
                    generationId,
                    message,
                );
            } catch (statusError: unknown) {
                this.logger.error(
                    `Failed to mark generation ${generationId} as FAILED`,
                    statusError instanceof Error
                        ? statusError.stack
                        : String(statusError),
                );
            }

            try {
                await this.prisma.platform.update({
                    where: { id: platformId },
                    data: { status: 'ERROR' },
                });
            } catch (platformError: unknown) {
                this.logger.error(
                    `Failed to set platform ${platformId} to ERROR`,
                    platformError instanceof Error
                        ? platformError.stack
                        : String(platformError),
                );
            }

            /*
             * We intentionally do not rethrow here because the original
             * architecture treats the generation failure as a handled
             * business state.
             */
        }
    }

    /**
     * Helper executing terminal sub-commands asynchronously and capturing standard outputs.
     * * @param generationId - ID of the generation entity for log stream targeting.
     * @param command - CLI executable name (`pnpm` or `npx`).
     * @param args - CLI argument array.
     * @param cwd - Working directory path where command executes.
     * @param timeoutMs - Maximum execution duration before timing out.
     */
    private async runStep(
        generationId: string,
        command: 'pnpm' | 'npx',
        args: string[],
        cwd: string,
        timeoutMs: number,
    ): Promise<void> {
        try {
            const { stdout, stderr } = await runCommand(
                command,
                args,
                cwd,
                timeoutMs,
            );

            if (stdout?.trim()) {
                await this.log(
                    generationId,
                    stdout.trim(),
                );
            }

            /*
             * stderr is not automatically treated as a failure.
             *
             * Some tools legitimately write warnings or informational
             * messages to stderr while still exiting successfully.
             *
             * We only rely on CommandFailedError to identify an actual
             * command failure.
             */
            if (stderr?.trim()) {
                await this.log(
                    generationId,
                    stderr.trim(),
                );
            }
        } catch (error: unknown) {
            if (error instanceof CommandFailedError) {
                const output =
                    error.stderr?.trim() ||
                    error.stdout?.trim();

                if (output) {
                    await this.log(
                        generationId,
                        output,
                    );
                }
            }

            throw error;
        }
    }

    /**
     * Appends a log line to the generation session log sequence.
     * Ignores empty or whitespace-only lines.
     */
    private async log(
        generationId: string,
        line: string,
    ): Promise<void> {
        const normalizedLine = line.trim();

        if (!normalizedLine) {
            return;
        }

        await this.generations.appendLog(
            generationId,
            normalizedLine,
        );
    }
}