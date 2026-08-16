import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { GENERATION_QUEUE_NAME } from './generator-queue.module';
import { PrismaService } from '../prisma/prisma.service';
import { ProvisioningService } from './provisioning.service';
import { ProjectScaffolderService } from './project-scaffolder.service';
import { GenerationsService } from './generations.service';
import { runCommand, CommandFailedError, CommandCancelledError } from '../common/utils/command-runner.util';
import { PortAllocatorService } from './port-allocator.service';
import { GenerationCancellationRegistry } from './generation-cancellation.registry';

/**
 * Interface defining the payload structure for background project generation jobs handled by BullMQ.
 */
export interface GenerationJobData {
    platformId: string;
    slug: string;
    generationId: string;
}

/**
 * BullMQ Worker Processor executing the automated platform code generation pipeline asynchronously.
 * It manages database provisioning, dynamic project scaffolding, package installation, database migrations, and TypeScript compilation.
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
        private readonly cancellationRegistry: GenerationCancellationRegistry,
    ) {
        super();
    }

    /**
     * Main task processing routine. Orchestrates the 7-step automated project build lifecycle.
     */
    async process(job: Job<GenerationJobData>): Promise<void> {
        const { platformId, slug, generationId } = job.data;
        const controller = this.cancellationRegistry.register(generationId);

        this.logger.log(
            `START generation job=${job.id} generationId=${generationId} platformId=${platformId}`,
        );
        
        // Fetch command execution timeout threshold (defaults to 5 minutes / 300,000ms)
        const timeoutMs = this.configService.get<number>('GENERATION_COMMAND_TIMEOUT_MS', 300_000);

        // Update the generation task and platform record status to notify the system that processing has started
        await this.generations.markRunning(generationId);
        await this.prisma.platform.update({
            where: { id: platformId },
            data: { status: 'GENERATING' },
        });

        try {
            // STEP 1: DATABASE PROVISIONING
            // Checks whether a database already exists for this platform or provisions a new isolated PostgreSql database.
            await this.log(generationId, '→ Checking database configuration...');
            let databaseUrl: string;
            const existingDatabase = await this.prisma.platformDatabase.findUnique({ where: { platformId } });

            if (existingDatabase) {
                databaseUrl = await this.provisioning.getDecryptedConnectionUrl(platformId);
                await this.log(generationId, `  Reusing existing database: ${existingDatabase.databaseName}`);
            } else {
                await this.log(generationId, '→ Provisioning new database...');
                const result = await this.provisioning.provisionDatabaseForPlatform(platformId, slug);
                databaseUrl = result.databaseUrl;
                await this.log(generationId, `  Database successfully created: ${result.databaseName}`);
            }

            // STEP 2: PROJECT SCAFFOLDING
            // Allocates a dedicated port and writes out source files, module definitions, and static configurations to disk.
            await this.log(generationId, '→ Scaffolding project files...');
            const port = await this.portAllocator.getOrAllocatePort(platformId);
            const { projectPath, isFirstGeneration } = await this.scaffolder.scaffold({ platformId, slug, databaseUrl, port });

            await this.log(generationId, `  Project scaffolded at ${projectPath}`);
            await this.log(generationId, isFirstGeneration ? '  Initial project generation detected.' : '  Re-generation detected: existing migration history preserved.');
            
            const envOverrides = { DATABASE_URL: databaseUrl };

            // STEP 3: INSTALL DEPENDENCIES
            // Runs `pnpm install` using --frozen-lockfile to guarantee deterministic package installation without altering pnpm-lock.yaml.
            await this.log(generationId, '→ Installing package dependencies...');
            await this.runStep(generationId, 'pnpm', ['install'], projectPath, timeoutMs, envOverrides, controller.signal);

            // STEP 4: GENERATE PRISMA CLIENT
            // Executes `prisma generate` to construct type-safe TypeScript database client types from the schema.prisma.
            await this.log(generationId, '→ Generating Prisma client...');
            await this.runStep(generationId, 'pnpm', ['exec', 'prisma', 'generate'], projectPath, timeoutMs, envOverrides, controller.signal);

            // STEP 5: DATABASE MIGRATIONS
            // Applies database structural changes using `prisma migrate deploy`. This non-interactive command applies pending SQL migrations safely.
            await this.log(generationId, '→ Applying Prisma database migrations...');
            await this.runStep(generationId, 'pnpm', ['exec', 'prisma', 'migrate', 'deploy'], projectPath, timeoutMs, envOverrides, controller.signal);

            // STEP 6: BUILD PROJECT
            // Compiles TypeScript source files into executable production JavaScript binaries inside the /dist folder.
            await this.log(generationId, '→ Compiling NestJS project...');
            await this.runStep(generationId, 'pnpm', ['run', 'build'], projectPath, timeoutMs, envOverrides, controller.signal);

            // STEP 7: SUCCESS COMPLETION
            // Updates schema versioning and transitions both the generation task and platform record status to active.
            const platform = await this.prisma.platform.findUniqueOrThrow({
                where: { id: platformId },
                select: { schemaVersion: true },
            });

            const nextSchemaVersion = platform.schemaVersion + 1;
            await this.generations.markSuccess(generationId, nextSchemaVersion);
            await this.prisma.platform.update({
                where: { id: platformId },
                data: { status: 'ACTIVE', schemaVersion: nextSchemaVersion },
            });

            await this.log(generationId, `✅ Generation completed successfully. Updated schema version: ${nextSchemaVersion}.`);
        } catch (error: unknown) {

            if (error instanceof CommandCancelledError) {
                await this.log(generationId, '⏹ Generation Cancelled.');
                await this.generations.markFailed(generationId, 'Cancelled by user.');
                await this.prisma.platform.update({ where: { id: platformId }, data: { status: 'ERROR' } });
            } else {
                const message = error instanceof Error ? error.message : String(error);
                await this.log(generationId, `❌ Échec : ${message}`);
                await this.generations.markFailed(generationId, message);
                await this.prisma.platform.update({ where: { id: platformId }, data: { status: 'ERROR' } });
            }

            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`Generation job ${generationId} failed.`, error instanceof Error ? error.stack : undefined);

            // Failure Recovery: Gracefully log error details and mark generation state as FAILED and platform state as ERROR.
            try { await this.log(generationId, `❌ Generation failed: ${message}`); } 
            catch (logError: unknown) { this.logger.error(`Failed to record failure log for generation ${generationId}.`, logError instanceof Error ? logError.stack : String(logError)); }

            try { await this.generations.markFailed(generationId, message); } 
            catch (statusError: unknown) { this.logger.error(`Failed to set status to FAILED for generation ${generationId}.`, statusError instanceof Error ? statusError.stack : String(statusError)); }

            try { await this.prisma.platform.update({ where: { id: platformId }, data: { status: 'ERROR' } }); } 
            catch (platformError: unknown) { this.logger.error(`Failed to set status to ERROR for platform ${platformId}.`, platformError instanceof Error ? platformError.stack : String(platformError)); }
        } finally {
            this.cancellationRegistry.clear(generationId);
        }
    }

    /**
     * Safely executes an external shell CLI command (e.g. pnpm) using isolated process execution and streams standard output to logs.
     */
    private async runStep(
        generationId: string,
        command: 'pnpm' | 'npx',
        args: string[],
        cwd: string,
        timeoutMs: number,
        envOverrides: Record<string, string> = {},
        signal?: AbortSignal,
    ): Promise<void> {
        try {
            const { stdout, stderr } = await runCommand(command, args, cwd, timeoutMs, envOverrides, signal);
            if (stdout?.trim()) { await this.log(generationId, stdout.trim()); }
            if (stderr?.trim()) { await this.log(generationId, stderr.trim()); }
        } catch (error: unknown) {
            if (error instanceof CommandFailedError) {
                const output = error.stderr?.trim() || error.stdout?.trim();
                if (output) {
                    try { await this.log(generationId, output); } 
                    catch (logError: unknown) { this.logger.error(`Failed to log execution output for failed command in generation ${generationId}.`, logError instanceof Error ? logError.stack : String(logError)); }
                }
            }
            throw error;
        }
    }

    /**
     * Appends a formatted line entry into the database build log history associated with the current generation run.
     */
    private async log(generationId: string, line: string): Promise<void> {
        const normalizedLine = line.trim();
        if (!normalizedLine) return;
        await this.generations.appendLog(generationId, normalizedLine);
    }
}