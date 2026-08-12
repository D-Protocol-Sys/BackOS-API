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
import { packageJsonObject, NEST_CLI_JSON, TSCONFIG_JSON, prismaConfigTemplate, prismaServiceTemplate, prismaModuleTemplate, mainTsTemplate, appModuleTemplate, envTemplate } from './templates/generated-project.templates';
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
    ) {}

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

        try {
            // Clean target directory and recreate basic folder architecture
            await fs.rm(projectPath, { recursive: true, force: true });
            await this.createProjectDirectories(projectPath);

            // Restore preserved migration directory back to project structure
            if (preservedMigrationsPath) {
                await fs.rename(preservedMigrationsPath, path.join(projectPath, 'prisma', 'migrations'));
                preservedMigrationsPath = null;
            }

            const activeServices = await this.prisma.platformService.findMany({
                where: { platformId: params.platformId },
                orderBy: { createdAt: 'asc' },
            });

            const prismaBlocks: string[] = [];
            const extraPnpmDeps: Record<string, string> = {};
            const extraEnvVars: Record<string, unknown> = {};
            const extraModules: { name: string; importPath: string }[] = [];

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
                fs.writeFile(path.join(projectPath, '.env'), envTemplate(params.databaseUrl, params.port, extraEnvVars), 'utf8'),
                fs.writeFile(path.join(projectPath, 'prisma', 'schema.prisma'), schemaContent, 'utf8'),
                fs.writeFile(path.join(projectPath, 'src', 'main.ts'), mainTsTemplate(), 'utf8'),
                fs.writeFile(path.join(projectPath, 'src', 'prisma', 'prisma.service.ts'), prismaServiceTemplate(), 'utf8'),
                fs.writeFile(path.join(projectPath, 'src', 'prisma', 'prisma.module.ts'), prismaModuleTemplate(), 'utf8'),
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
     * Resolves the target root execution path for generated platform applications.
     */
    private resolveProjectPath(slug: string): string {
        return path.join(this.getGeneratedRoot(), slug, 'backend');
    }

    /**
     * Computes absolute path for the generated project output directory based on environment variables.
     */
    private getGeneratedRoot(): string {
        const root = this.configService.get<string>('app.generatedProjectsRoot', 'generated');
        return path.isAbsolute(root) ? path.normalize(root) : path.resolve(process.cwd(), root);
    }
}