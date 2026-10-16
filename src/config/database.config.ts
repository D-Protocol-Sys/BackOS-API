import { registerAs } from '@nestjs/config';

/**
 * Database Configuration Factory ('database' namespace)
 * * Organizes database-related environment variables into a strongly-typed,
 * isolated configuration object using NestJS's `registerAs` helper.
 * * Usage:
 * - Inject via ConfigService: `this.configService.get<string>('database.url')`
 * - Or use custom configuration decorators for direct property access.
 */
export default registerAs('database', () => ({
    /**
     * Main Application Connection String.
     * * Points to the primary application database with standard application-level privileges.
     * Consumed by ORMs (e.g., Prisma, TypeORM) for standard data persistence and migrations.
     * * @example "postgresql://app_user:pass@localhost:5432/app_db?schema=public"
     */
    url: process.env.DATABASE_URL,

    /**
     * Administrative / Provisioning Connection String.
     * * Connects with elevated administrative permissions (e.g., targeting the default 'postgres' database).
     * Used exclusively by the `ProvisioningService` to execute DDL commands (`CREATE DATABASE`, `CREATE ROLE`).
     * * @example "postgresql://provisioner:admin_pass@localhost:5432/postgres"
     */
    provisioningUrl: process.env.POSTGRES_PROVISIONING_URL,

    /**
     * Dedicated Administrative Role Name.
     * * Specifies the custom PostgreSQL role name that holds `CREATEDB` and `CREATEROLE` permissions.
     * Used during temporary membership grants when assigning database ownership.
     * * @example "backos_provisioner"
     */
    provisioningRole: process.env.POSTGRES_PROVISIONING_ROLE,

    /**
     * Hostname / IP for Target Tenant Databases.
     * * Defines where newly provisioned tenant databases will be hosted or accessed from.
     * Defaults to system host or localhost if omitted in service calls.
     * * @example "localhost" or "db.internal.network"
     */
    provisioningHost: process.env.PROVISION_HOST,

    /**
     * Network Port for Target Tenant Databases.
     * * Defines the target PostgreSQL port for dynamic connection string assembly.
     * * @example 5432
     */
    provisioningPort: process.env.PROVISION_PORT ? parseInt(process.env.PROVISION_PORT, 10) : undefined,

    /**
     * Shared Shadow Database Name (see `ProvisioningService.ensureShadowDatabaseUrl()`).
     * * A single, persistent database used exclusively as Prisma's scratch space for
     * `prisma migrate diff --from-migrations ...` (see `GenerationProcessor.
     * generateMigrationIfNeeded()`) - required by Prisma to replay a migration history and
     * compute what it results in, entirely separate from any platform's own real database.
     * Owned by `provisioningRole`, never granted to any per-platform database role.
     * * @example "backos_migration_shadow"
     */
    shadowDatabaseName: process.env.POSTGRES_SHADOW_DATABASE_NAME ?? 'migration_shadow',
}));
