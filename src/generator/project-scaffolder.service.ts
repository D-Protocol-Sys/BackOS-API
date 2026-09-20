import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SchemaBuilderService } from './schema-builder.service';
import { CrudGeneratorService } from './crud-generator.service';
import { PlatformServicesService } from './platform-services.service';
import { ServiceCatalog } from './service-catalog/service-catalog';
import { SERVICE_FILE_GENERATORS } from './service-catalog/service-file-generators';
import { PrismaService } from '../prisma/prisma.service';
import { packageJsonObject, NEST_CLI_JSON, TSCONFIG_JSON, prismaConfigTemplate, prismaServiceTemplate, prismaModuleTemplate, mainTsTemplate, appModuleTemplate, envTemplate, healthControllerTemplate, healthModuleTemplate, dockerfileTemplate, dockerignoreTemplate, npmrcTemplate, pnpmWorkspaceYamlTemplate, uploadsControllerTemplate, uploadsModuleTemplate, uploadsMulterConfigTemplate } from './templates/generated-project.templates';
import { computeRelationFieldsByEntity } from '../common/utils/relation-metadata.util';

const SAFE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Service responsible for scaffolding and re-generating dynamic NestJS backend projects on disk.
 * Handles migration history preservation, schema composition, CRUD generation, and template rendering.
 */
@Injectable()
export class ProjectScaffolderService {
    private readonly logger = new Logger(ProjectScaffolderService.name);

    constructor(
        private readonly schemaBuilder: SchemaBuilderService,
        private readonly crudGenerator: CrudGeneratorService,
        private readonly platformServices: PlatformServicesService,
        private readonly serviceCatalog: ServiceCatalog,
        private readonly prisma: PrismaService,
        private readonly configService: ConfigService,
    ) {
        this.warnIfGeneratedRootIsUnsafe();
    }

    /**
     * Guards against the exact incident that motivated this check: `GENERATED_PROJECTS_ROOT`
     * defaults to the relative path `'generated'`, resolved against `process.cwd()` - which,
     * unless explicitly overridden, lands INSIDE this very backend's own project directory. In
     * dev mode this backend typically runs under a file watcher (`nest start --watch` /
     * nodemon / ts-node-dev), and every regeneration wipes and rewrites the entire generated
     * project (`pnpm install` + `pnpm run build`, i.e. a large, fast burst of filesystem
     * writes) inside that now-watched directory. The watcher eventually trips and restarts
     * this whole process mid-generation - which is what killed the BullMQ job the reconciliation
     * logic in `GenerationProcessor` now has to clean up after. Regenerating an existing
     * platform reliably reproduces it because it rewrites far more files than a first-time
     * scaffold does; a first generation can slip through without tripping the watcher.
     *
     * This can't safely be made a hard failure here (some deployments may legitimately want the
     * generated root under the same parent directory but past a symlink or bind mount this
     * check can't see through), so it logs loudly instead of throwing - but it makes the
     * misconfiguration impossible to miss instead of manifesting as an unexplained restart.
     */
    private warnIfGeneratedRootIsUnsafe(): void {
        const resolvedRoot = this.getGeneratedRoot();
        const cwd = process.cwd();
        const relative = path.relative(cwd, resolvedRoot);
        const isInsideCwd = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);

        if (isInsideCwd) {
            this.logger.warn(
                `GENERATED_PROJECTS_ROOT ("${resolvedRoot}") is located INSIDE this backend's own working directory ` +
                `("${cwd}"). If this process runs under a dev-mode file watcher (nest start --watch / nodemon / ` +
                `ts-node-dev), every project regeneration will rewrite a large number of files under this path and ` +
                `is very likely to trigger the watcher to restart this backend mid-generation. Set GENERATED_PROJECTS_ROOT ` +
                `to an absolute path outside this project's directory (e.g. /var/lib/backos/generated) to fix this.`,
            );
        }
    }

    /**
     * Scaffolds a complete standalone NestJS application directory for a given platform.
     * Preserves existing Prisma migration history during project regeneration.
     */
    async scaffold(params: { platformId: string; slug: string; databaseUrl: string; port: number }): Promise<{ projectPath: string; isFirstGeneration: boolean }> {
        this.validateSlug(params.slug);

        const projectPath = this.resolveProjectPath(params.slug);
        const migrationsPath = path.join(projectPath, 'prisma', 'migrations');
        const hasExistingMigrations = await this.hasMigrationHistory(migrationsPath);

        let preservedMigrationsPath: string | null = null;
        if (hasExistingMigrations) {
            preservedMigrationsPath = await this.preserveMigrations(projectPath);
        }

        // BUGFIX: previously-uploaded files (see UploadsController / uploadsMulterConfigTemplate())
        // live at `<projectPath>/uploads/` - a sibling of `src/`, so the unconditional
        // `fs.rm(projectPath, { recursive: true, force: true })` a few lines down used to wipe
        // every file anyone had ever uploaded on this platform on every single regeneration
        // (e.g. just adding an unrelated field to a different entity). Any IMAGE/FILE field
        // value already saved in the platform's own database would then point at a file that no
        // longer exists - a broken image the moment someone next visits the page. Preserved and
        // restored with the exact same move-out/move-back pattern already used for
        // `prisma/migrations/` above.
        const uploadsPath = path.join(projectPath, 'uploads');
        let preservedUploadsPath = await this.preserveUploadsIfPresent(uploadsPath);

        try {
            // Clean target directory and recreate basic folder architecture
            await fs.rm(projectPath, { recursive: true, force: true });
            await this.createProjectDirectories(projectPath);

            // Restore preserved migration directory back to project structure
            if (preservedMigrationsPath) {
                await fs.rename(preservedMigrationsPath, path.join(projectPath, 'prisma', 'migrations'));
                preservedMigrationsPath = null;
            }

            if (preservedUploadsPath) {
                await fs.rename(preservedUploadsPath, uploadsPath);
                preservedUploadsPath = null;
            }

            const activeServices = await this.prisma.platformService.findMany({
                where: { platformId: params.platformId },
                orderBy: { createdAt: 'asc' },
            });

            const prismaBlocks: string[] = [];
            const extraPnpmDeps: Record<string, string> = {};
            const extraEnvVars: Record<string, unknown> = {};
            const extraModules: { name: string; importPath: string }[] = [
                // BUGFIX: `health.controller.ts`/`health.module.ts` were written to disk by
                // every generation (below) but never wired into `AppModule` - meaning
                // `/generated-api/health` 404'd on every single generated backend, ever. Both
                // `RuntimeManagerService.pingHealth()` and `DockerRuntimeManagerService.
                // pingHealth()` poll exactly that route to flip a platform from STARTING to
                // RUNNING and to report `healthy: true/false` - so this silently broke the
                // "is this backend actually up" signal everywhere it's used, including the
                // Docker image's own `HEALTHCHECK` instruction (see `dockerfileTemplate()`).
                // Always included, unconditionally, for every platform - like `PrismaModule`.
                { name: 'HealthModule', importPath: './health/health.module' },
                // Always included too - see `uploadsControllerTemplate()` / `uploadsModuleTemplate()`.
                // Every generated project can have IMAGE/FILE fields (see `schema-builder.
                // service.ts`), and until now nothing on the generated backend actually served
                // an upload endpoint for them - the frontend's `uploadToGeneratedBackend()` had
                // no route to call.
                { name: 'UploadsModule', importPath: './uploads/uploads.module' },
            ];

            // Add Redis configuration if scheduler service is active
            if (activeServices.some((service) => service.serviceKey === 'scheduler')) {
                extraEnvVars.redisHost = this.configService.get<string>('REDIS_HOST', 'localhost');
                extraEnvVars.redisPort = this.configService.get<number>('REDIS_PORT', 6379);
            }

            // Aggregate Prisma models, dependencies, environment configs, and code generation hooks for active services
            for (const service of activeServices) {
                const blueprint = this.serviceCatalog.getByKey(service.serviceKey);
                if (blueprint.prismaModels) { prismaBlocks.push(blueprint.prismaModels); }
                Object.assign(extraPnpmDeps, blueprint.pnpmDependencies);
                const fullConfig = await this.platformServices.getFullDecryptedConfig(params.platformId, service.serviceKey);
                Object.assign(extraEnvVars, fullConfig);
                const generatorFn = SERVICE_FILE_GENERATORS[service.serviceKey];
                if (generatorFn) {
                    const modules = await generatorFn(projectPath, fullConfig);
                    extraModules.push(...modules);
                }
            }

            // Build dynamic Prisma schema and fetch entity definitions
            const schemaContent = await this.schemaBuilder.buildSchema(params.platformId, prismaBlocks);
            const entities = await this.schemaBuilder.getActiveEntitiesWithFields(params.platformId);

            // CORS: gather every frontend origin allowed to call the generated backend
            // directly from a browser - see the CORS note on `mainTsTemplate()` for the full
            // rationale. Two sources, both optional, de-duplicated and with blanks dropped:
            //   1. This platform's own `url` field (its public frontend, e.g. a portfolio site).
            //   2. BackOS's own `FRONTEND_URL` (the backoffice used to fill this platform's data).
            const platform = await this.prisma.platform.findUnique({ where: { id: params.platformId } });
            const corsOrigins = Array.from(
                new Set(
                    [platform?.url, this.configService.get<string>('app.frontendUrl')].filter(
                        (origin): origin is string => Boolean(origin && origin.trim()),
                    ),
                ),
            );

            // Verify auth service active status if any entities specify auth protection rules
            const activeServiceKeys = new Set(activeServices.map((service) => service.serviceKey));
            const entitiesRequiringAuth = entities.filter((entity) => entity.authProtectCreate || entity.authProtectRead || entity.authProtectUpdate || entity.authProtectDelete);
            if (entitiesRequiringAuth.length > 0 && !activeServiceKeys.has('auth-user')) {
                throw new BadRequestException(`Les entités suivantes exigent une authentification mais "Auth & User" n'est plus actif : ${entitiesRequiringAuth.map((entity) => entity.tableName).join(', ')}`);
            }

            // Map relationship metadata across dynamic entities
            const relations = await this.prisma.relation.findMany({ where: { platformId: params.platformId } });
            const relationFieldsByEntity = computeRelationFieldsByEntity(entities.map((entity) => ({ id: entity.id, tableName: entity.tableName })), relations);
            const entityIdByTableName = new Map(entities.map((entity) => [entity.tableName, entity.id]));

            // Write core application configuration files, schema, and base templates
            await Promise.all([
                fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify(packageJsonObject(params.slug, extraPnpmDeps), null, 2), 'utf8'),
                fs.writeFile(path.join(projectPath, 'nest-cli.json'), NEST_CLI_JSON, 'utf8'),
                fs.writeFile(path.join(projectPath, 'tsconfig.json'), TSCONFIG_JSON, 'utf8'),
                fs.writeFile(path.join(projectPath, 'prisma.config.ts'), prismaConfigTemplate(), 'utf8'),
                fs.writeFile(
                    path.join(projectPath, '.env'),
                    envTemplate(
                        params.databaseUrl,
                        params.port,
                        extraEnvVars,
                        this.configService.get<string>('GENERATED_BACKEND_HOST', '127.0.0.1'),
                        corsOrigins,
                    ),
                    'utf8',
                ),
                fs.writeFile(path.join(projectPath, 'prisma', 'schema.prisma'), schemaContent, 'utf8'),
                fs.writeFile(path.join(projectPath, 'src', 'main.ts'), mainTsTemplate(), 'utf8'),
                fs.writeFile(path.join(projectPath, 'src', 'prisma', 'prisma.service.ts'), prismaServiceTemplate(), 'utf8'),
                fs.writeFile(path.join(projectPath, 'src', 'prisma', 'prisma.module.ts'), prismaModuleTemplate(), 'utf8'),
                fs.writeFile(path.join(projectPath, 'src', 'health', 'health.controller.ts'), healthControllerTemplate(), 'utf8'),
                fs.writeFile(path.join(projectPath, 'src', 'health', 'health.module.ts'), healthModuleTemplate(), 'utf8'),
                fs.writeFile(path.join(projectPath, 'src', 'uploads', 'uploads.controller.ts'), uploadsControllerTemplate(), 'utf8'),
                fs.writeFile(path.join(projectPath, 'src', 'uploads', 'uploads.module.ts'), uploadsModuleTemplate(), 'utf8'),
                fs.writeFile(path.join(projectPath, 'src', 'uploads', 'uploads.multer-config.ts'), uploadsMulterConfigTemplate(), 'utf8'),
                // Written unconditionally on every generation, whether or not Docker isolation
                // is currently enabled (see DockerRuntimeManagerService / GENERATED_BACKEND_RUNTIME),
                // so switching the runtime mode never requires a fresh generation first.
                fs.writeFile(path.join(projectPath, 'Dockerfile'), dockerfileTemplate(), 'utf8'),
                fs.writeFile(path.join(projectPath, '.dockerignore'), dockerignoreTemplate(), 'utf8'),
                // Paired with the `COPY .npmrc ./` lines in dockerfileTemplate() - see the
                // comment on npmrcTemplate() for why this is required for `pnpm install` to
                // succeed inside the Docker build at all (pnpm 11's `minimumReleaseAge` default).
                fs.writeFile(path.join(projectPath, '.npmrc'), npmrcTemplate(), 'utf8'),
                // As of pnpm 11, .npmrc no longer carries non-auth settings - minimumReleaseAge
                // must additionally live here. See the comment on pnpmWorkspaceYamlTemplate().
                fs.writeFile(path.join(projectPath, 'pnpm-workspace.yaml'), pnpmWorkspaceYamlTemplate(), 'utf8'),
            ]);

            // Generate full CRUD controllers/services for each dynamic entity
            await this.crudGenerator.generateModulesForEntities(projectPath, entities, relationFieldsByEntity, entityIdByTableName);

            // Assemble root application module linking all CRUD and service modules
            await fs.writeFile(path.join(projectPath, 'src', 'app.module.ts'), appModuleTemplate(entities, extraModules), 'utf8');

            this.logger.log(`Projet généré : ${projectPath} (services: ${activeServices.map((service) => service.serviceKey).join(', ') || 'aucun'}, migrations: ${hasExistingMigrations ? 'existantes' : 'initiales'})`);

            return { projectPath, isFirstGeneration: !hasExistingMigrations };
        } catch (error) {
            // Attempt emergency restoration of preserved migration folder if generation fails midway
            if (preservedMigrationsPath) {
                try {
                    await fs.mkdir(path.join(projectPath, 'prisma'), { recursive: true });
                    await fs.rename(preservedMigrationsPath, path.join(projectPath, 'prisma', 'migrations'));
                    preservedMigrationsPath = null;
                } catch (restoreError) {
                    this.logger.error(`Impossible de restaurer l'historique des migrations pour "${params.slug}".`, restoreError instanceof Error ? restoreError.stack : String(restoreError));
                }
            }
            if (preservedUploadsPath) {
                try {
                    await fs.rename(preservedUploadsPath, uploadsPath);
                    preservedUploadsPath = null;
                } catch (restoreError) {
                    this.logger.error(`Impossible de restaurer les fichiers uploadés pour "${params.slug}".`, restoreError instanceof Error ? restoreError.stack : String(restoreError));
                }
            }
            throw error;
        } finally {
            // Cleanup lingering temporary preservation folder if still present
            if (preservedMigrationsPath) {
                try {
                    await fs.rm(preservedMigrationsPath, { recursive: true, force: true });
                } catch (cleanupError) {
                    this.logger.error(`Impossible de nettoyer le répertoire temporaire des migrations pour "${params.slug}".`, cleanupError instanceof Error ? cleanupError.stack : String(cleanupError));
                }
            }
            if (preservedUploadsPath) {
                try {
                    await fs.rm(preservedUploadsPath, { recursive: true, force: true });
                } catch (cleanupError) {
                    this.logger.error(`Impossible de nettoyer le répertoire temporaire des fichiers uploadés pour "${params.slug}".`, cleanupError instanceof Error ? cleanupError.stack : String(cleanupError));
                }
            }
        }
    }

    /**
     * Validates that the platform slug complies with safe URL/folder naming regex rules.
     */
    private validateSlug(slug: string): void {
        if (typeof slug !== 'string' || slug.length === 0 || slug.length > 100 || !SAFE_SLUG_PATTERN.test(slug)) {
            throw new BadRequestException(`Slug de plateforme invalide : "${slug}"`);
        }
    }

    /**
     * Initializes directory paths needed for project source code and Prisma artifacts.
     */
    private async createProjectDirectories(projectPath: string): Promise<void> {
        await fs.mkdir(path.join(projectPath, 'src', 'prisma'), { recursive: true });
        await fs.mkdir(path.join(projectPath, 'src', 'health'), { recursive: true }),
        await fs.mkdir(path.join(projectPath, 'src', 'uploads'), { recursive: true }),
        await fs.mkdir(path.join(projectPath, 'prisma'), { recursive: true });
    }

    /**
     * Checks if a valid Prisma migration history exists in the targeted project directory.
     */
    private async hasMigrationHistory(migrationsPath: string): Promise<boolean> {
        try {
            const entries = await fs.readdir(migrationsPath, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const migrationFile = path.join(migrationsPath, entry.name, 'migration.sql');
                try {
                    await fs.access(migrationFile);
                    return true;
                } catch {
                    // Entry is not a valid migration directory
                }
            }
            return false;
        } catch {
            return false;
        }
    }

    /**
     * Safely moves the migrations folder to a sibling temporary folder outside the current project root.
     */
    private async preserveMigrations(projectPath: string): Promise<string> {
        const migrationsPath = path.join(projectPath, 'prisma', 'migrations');
        const projectParent = path.dirname(projectPath);
        const projectName = path.basename(projectPath);
        const temporaryPath = path.join(projectParent, `.migration-preservation-${projectName}-${Date.now()}-${process.pid}`);

        await fs.rename(migrationsPath, temporaryPath);
        return temporaryPath;
    }

    /**
     * Safely moves a platform's uploaded-files folder to a sibling temporary folder outside the
     * current project root, if it exists - mirrors `preserveMigrations()`, but with no
     * equivalent to `hasMigrationHistory()`'s validity check: any uploads folder that exists at
     * all is worth preserving, unconditionally (there's no analogous notion of an "invalid"
     * uploads folder the way an incomplete migration history would be).
     */
    private async preserveUploadsIfPresent(uploadsPath: string): Promise<string | null> {
        const projectPath = path.dirname(uploadsPath);
        const projectParent = path.dirname(projectPath);
        const projectName = path.basename(projectPath);
        const temporaryPath = path.join(projectParent, `.uploads-preservation-${projectName}-${Date.now()}-${process.pid}`);

        try {
            await fs.rename(uploadsPath, temporaryPath);
            return temporaryPath;
        } catch {
            // No uploads folder yet (first generation, or nothing has ever been uploaded) -
            // nothing to preserve.
            return null;
        }
    }

    /**
     * Resolves the target root execution path for generated platform applications.
     */
    private resolveProjectPath(slug: string): string {
        return path.join(this.getGeneratedRoot(), slug, 'backend');
    }

    /**
     * Public wrapper around the slug's top-level generated directory (the parent of `backend/`,
     * so it covers everything ever written for this platform, not just the app code itself).
     * Used by `PlatformsService.purge()`/`purgeExpiredArchives()` to remove every on-disk trace
     * of a platform being permanently deleted, without duplicating the path-building logic (and
     * risking it drifting out of sync with `resolveProjectPath()`/`getGeneratedRoot()` above).
     */
    getSlugRootPath(slug: string): string {
        return path.join(this.getGeneratedRoot(), slug);
    }

    /**
     * Computes absolute path for the generated project output directory based on environment variables.
     */
    private getGeneratedRoot(): string {
        const root = this.configService.get<string>('app.generatedProjectsRoot', 'generated');
        return path.isAbsolute(root) ? path.normalize(root) : path.resolve(process.cwd(), root);
    }
}