import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, escapeIdentifier, escapeLiteral } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/services/crypto.service';
import {
    platformSlugToDbName,
    platformSlugToDbUser,
    generateSecurePassword,
    shadowDatabaseRoleName,
} from '../common/utils/db-identifier.util';

interface ProvisionResult {
    host: string;
    port: number;
    databaseName: string;
    databaseUser: string;
    databaseUrl: string;
}

interface ProvisioningResources {
    roleCreated: boolean;
    databaseCreated: boolean;
}

/** Bounds every administrative statement so a stuck PostgreSQL cannot freeze a generation job forever. */
const ADMIN_CONNECTION_TIMEOUT_MS = 10_000;
const ADMIN_STATEMENT_TIMEOUT_MS = 120_000;

@Injectable()
export class ProvisioningService {
    private readonly logger = new Logger(ProvisioningService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly configService: ConfigService,
        private readonly cryptoService: CryptoService,
    ) {}

    /**
     * Provisions a dedicated, isolated PostgreSQL database for a platform.
     * Idempotent: guarded by a PostgreSQL advisory lock and a double check of the metadata row.
     *
     * RELIABILITY FIX (scenario C of the audit): database and role names now embed a hash of the
     * platform id (DB-003), so a role/database that exists WITHOUT a metadata row can only be the
     * leftover of a previous attempt for this very platform that crashed between `CREATE ROLE`
     * and the metadata insert. It is dropped and recreated instead of failing forever.
     */
    async provisionDatabaseForPlatform(platformId: string, slug: string): Promise<ProvisionResult> {
        const host = this.configService.get<string>('database.provisioningHost', 'localhost');
        const port = this.configService.get<number>('database.provisioningPort', 5432);
        const encryptionKey = this.configService.getOrThrow<string>('security.encryptionKey');
        const serverName = this.configService.getOrThrow<string>('app.serverName');

        const existingDatabase = await this.prisma.platformDatabase.findUnique({ where: { platformId } });
        if (existingDatabase) {
            return this.toResult(existingDatabase, await this.getDecryptedConnectionUrl(platformId));
        }

        const dbName = platformSlugToDbName(slug, platformId);
        const dbUser = platformSlugToDbUser(slug, platformId);
        const adminClient = this.getAdminClient();
        await adminClient.connect();
        const lockKey = `${serverName}:provision:${platformId}`;
        const resources: ProvisioningResources = { roleCreated: false, databaseCreated: false };

        try {
            await this.acquireLock(adminClient, lockKey);

            const databaseAfterLock = await this.prisma.platformDatabase.findUnique({ where: { platformId } });
            if (databaseAfterLock) {
                return this.toResult(databaseAfterLock, await this.getDecryptedConnectionUrl(platformId));
            }

            const roleIdentifier = escapeIdentifier(dbUser);
            const databaseIdentifier = escapeIdentifier(dbName);
            const provisionRoleIdentifier = escapeIdentifier(this.configService.getOrThrow<string>('database.provisioningRole'));

            // Leftovers of a crashed previous attempt for THIS platform (names are platform-id-derived).
            const leftoverRole = await adminClient.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [dbUser]);
            const leftoverDatabase = await adminClient.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
            if ((leftoverRole.rowCount ?? 0) > 0 || (leftoverDatabase.rowCount ?? 0) > 0) {
                this.logger.warn(
                    `Found PostgreSQL leftovers for platform "${platformId}" without a metadata record ` +
                    `(interrupted provisioning). Dropping "${dbName}" / "${dbUser}" before recreating them.`,
                );
                await this.dropPlatformResources(adminClient, dbName, dbUser);
            }

            // SECURITY/CONCURRENCY FIX (GEN-003): the password is a local variable - it used to be
            // stored on this singleton (`this.pendingPassword`) where two concurrent provisionings
            // could swap or lose each other's password.
            const password = generateSecurePassword();
            await adminClient.query(`CREATE ROLE ${roleIdentifier} WITH LOGIN PASSWORD ${escapeLiteral(password)}`);
            resources.roleCreated = true;

            // Temporarily grant the owner role to the provisioner so it can create a database owned by it.
            await adminClient.query(`GRANT ${roleIdentifier} TO ${provisionRoleIdentifier}`);
            try {
                // CREATE DATABASE cannot run inside an explicit transaction block.
                await adminClient.query(`CREATE DATABASE ${databaseIdentifier} OWNER ${roleIdentifier}`);
                resources.databaseCreated = true;
            } finally {
                await adminClient.query(`REVOKE ${roleIdentifier} FROM ${provisionRoleIdentifier}`);
            }

            await adminClient.query(`REVOKE ALL ON DATABASE ${databaseIdentifier} FROM PUBLIC`);

            try {
                await this.prisma.platformDatabase.create({
                    data: {
                        platformId,
                        host,
                        port,
                        databaseName: dbName,
                        databaseUser: dbUser,
                        encryptedPassword: this.cryptoService.encryptWithRawKey(password, encryptionKey),
                    },
                });
            } catch (metadataError) {
                this.logger.error(
                    `Database "${dbName}" created successfully, but system metadata registration failed.`,
                    metadataError instanceof Error ? metadataError.stack : String(metadataError),
                );
                await this.cleanupCreatedResources(adminClient, dbName, dbUser, resources);
                throw new InternalServerErrorException('PostgreSQL database created, but internal registration failed.');
            }

            return {
                host,
                port,
                databaseName: dbName,
                databaseUser: dbUser,
                databaseUrl: this.buildDatabaseUrl(host, port, dbName, dbUser, password),
            };
        } catch (error) {
            this.logger.error(
                `Provisioning failed for platform "${platformId}".`,
                error instanceof Error ? error.stack : String(error),
            );
            if (resources.databaseCreated || resources.roleCreated) {
                await this.cleanupCreatedResources(adminClient, dbName, dbUser, resources);
            }
            if (error instanceof InternalServerErrorException) throw error;
            throw new InternalServerErrorException('Failed to provision platform PostgreSQL infrastructure.');
        } finally {
            await this.releaseLockQuietly(adminClient, lockKey, platformId);
            await adminClient.end().catch(() => undefined);
        }
    }

    /** Decrypts and compiles full database connection string metadata. */
    async getDecryptedConnectionUrl(platformId: string): Promise<string> {
        const record = await this.prisma.platformDatabase.findUniqueOrThrow({ where: { platformId } });
        const encryptionKey = this.configService.getOrThrow<string>('security.encryptionKey');
        const password = this.cryptoService.decryptWithRawKey(record.encryptedPassword, encryptionKey);
        return this.buildDatabaseUrl(record.host, record.port, record.databaseName, record.databaseUser, password);
    }

    /**
     * Drops the platform's database and role, then its metadata row.
     *
     * Called by `PlatformsService` before a platform is permanently deleted (DB-001): the
     * method used to exist without any caller, so "permanently deleted" platforms kept their
     * database, their end users' data and a LOGIN role forever.
     */
    async deprovisionDatabaseForPlatform(platformId: string): Promise<void> {
        const record = await this.prisma.platformDatabase.findUnique({ where: { platformId } });
        if (!record) return;

        const serverName = this.configService.getOrThrow<string>('app.serverName');
        const lockKey = `${serverName}:provision:${platformId}`;
        const adminClient = this.getAdminClient();
        await adminClient.connect();

        try {
            await this.acquireLock(adminClient, lockKey);
            const currentRecord = await this.prisma.platformDatabase.findUnique({ where: { platformId } });
            if (!currentRecord) return;

            await this.dropPlatformResources(adminClient, currentRecord.databaseName, currentRecord.databaseUser);
            await this.prisma.platformDatabase.delete({ where: { platformId } });
        } catch (error) {
            this.logger.error(
                `Deprovisioning failed for platform "${platformId}".`,
                error instanceof Error ? error.stack : String(error),
            );
            throw new InternalServerErrorException('Failed to completely deprovision PostgreSQL resources.');
        } finally {
            await this.releaseLockQuietly(adminClient, lockKey, platformId);
            await adminClient.end().catch(() => undefined);
        }
    }

    private toResult(
        record: { host: string; port: number; databaseName: string; databaseUser: string },
        databaseUrl: string,
    ): ProvisionResult {
        return {
            host: record.host,
            port: record.port,
            databaseName: record.databaseName,
            databaseUser: record.databaseUser,
            databaseUrl,
        };
    }

    private async cleanupCreatedResources(
        adminClient: Client,
        dbName: string,
        dbUser: string,
        resources: ProvisioningResources,
    ): Promise<void> {
        try {
            if (resources.databaseCreated) await this.dropDatabase(adminClient, dbName, dbUser);
            if (resources.roleCreated) await this.dropRole(adminClient, dbUser);
        } catch (cleanupError) {
            this.logger.error(
                `PARTIAL CLEANUP ERROR: Failed to destroy allocated PostgreSQL resources "${dbName}" / "${dbUser}".`,
                cleanupError instanceof Error ? cleanupError.stack : String(cleanupError),
            );
        }
    }

    private async dropPlatformResources(adminClient: Client, dbName: string, dbUser: string): Promise<void> {
        await this.dropDatabase(adminClient, dbName, dbUser);
        await this.dropRole(adminClient, dbUser);
    }

    /** Terminates client sessions and drops the database (re-granting ownership membership first). */
    private async dropDatabase(adminClient: Client, dbName: string, dbUser?: string): Promise<void> {
        if (dbUser) {
            const roleExists = await adminClient.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [dbUser]);
            if (roleExists.rowCount === 1) {
                const provisionRoleName = this.configService.getOrThrow<string>('database.provisioningRole');
                await adminClient.query(`GRANT ${escapeIdentifier(dbUser)} TO ${escapeIdentifier(provisionRoleName)}`);
            }
        }

        await adminClient.query(
            'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
            [dbName],
        );
        await adminClient.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(dbName)}`);
    }

    private async dropRole(adminClient: Client, dbUser: string): Promise<void> {
        await adminClient.query(`DROP ROLE IF EXISTS ${escapeIdentifier(dbUser)}`);
    }

    private async acquireLock(adminClient: Client, lockKey: string): Promise<void> {
        await adminClient.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    }

    private async releaseLock(adminClient: Client, lockKey: string): Promise<void> {
        await adminClient.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
    }

    private async releaseLockQuietly(adminClient: Client, lockKey: string, context: string): Promise<void> {
        try {
            await this.releaseLock(adminClient, lockKey);
        } catch (unlockError) {
            this.logger.error(
                `Failed to release advisory lock "${lockKey}" (${context}).`,
                unlockError instanceof Error ? unlockError.stack : String(unlockError),
            );
        }
    }

    /** Standard Postgres connection string, encoding special characters and handling IPv6 hosts. */
    private buildDatabaseUrl(host: string, port: number, databaseName: string, databaseUser: string, password: string): string {
        const normalizedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
        return `postgresql://${encodeURIComponent(databaseUser)}:${encodeURIComponent(password)}@${normalizedHost}:${port}/${encodeURIComponent(databaseName)}?schema=public`;
    }

    private shadowDatabaseUrlCache: string | null = null;

    /**
     * Ensures the persistent database Prisma uses as scratch space for `prisma migrate diff`
     * exists, and returns a connection URL for it.
     *
     * SECURITY FIX (SEC-001 / SEC-004): the URL handed to the generated project's Prisma CLI used
     * to carry the PROVISIONING credentials (CREATEDB + CREATEROLE, or even the superuser in the
     * Docker stacks). It now uses a dedicated role that owns only this scratch database and has no
     * other privilege. Its password is regenerated at every boot and never persisted.
     */
    async ensureShadowDatabaseUrl(): Promise<string> {
        if (this.shadowDatabaseUrlCache) return this.shadowDatabaseUrlCache;

        const shadowDbName = this.configService.get<string>('database.shadowDatabaseName', 'backos_migration_shadow');
        const provisionRoleName = this.configService.getOrThrow<string>('database.provisioningRole');
        const serverName = this.configService.getOrThrow<string>('app.serverName');
        const shadowRole = shadowDatabaseRoleName();
        const shadowPassword = generateSecurePassword();

        const adminClient = this.getAdminClient();
        await adminClient.connect();
        const lockKey = `${serverName}:shadow-database`;

        try {
            await this.acquireLock(adminClient, lockKey);

            const roleIdentifier = escapeIdentifier(shadowRole);
            const databaseIdentifier = escapeIdentifier(shadowDbName);
            const provisionRoleIdentifier = escapeIdentifier(provisionRoleName);

            const roleExists = await adminClient.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [shadowRole]);
            if (roleExists.rowCount === 0) {
                await adminClient.query(`CREATE ROLE ${roleIdentifier} WITH LOGIN PASSWORD ${escapeLiteral(shadowPassword)}`);
            } else {
                await adminClient.query(`ALTER ROLE ${roleIdentifier} WITH LOGIN PASSWORD ${escapeLiteral(shadowPassword)}`);
            }

            await adminClient.query(`GRANT ${roleIdentifier} TO ${provisionRoleIdentifier}`);
            try {
                const existing = await adminClient.query('SELECT 1 FROM pg_database WHERE datname = $1', [shadowDbName]);
                if (existing.rowCount === 0) {
                    await adminClient.query(`CREATE DATABASE ${databaseIdentifier} OWNER ${roleIdentifier}`);
                    this.logger.log(`Shadow database created for migration diffs: "${shadowDbName}".`);
                } else {
                    // Databases created by earlier versions were owned by the provisioning role.
                    await adminClient.query(`ALTER DATABASE ${databaseIdentifier} OWNER TO ${roleIdentifier}`);
                }
            } finally {
                await adminClient.query(`REVOKE ${roleIdentifier} FROM ${provisionRoleIdentifier}`);
            }
            await adminClient.query(`REVOKE ALL ON DATABASE ${databaseIdentifier} FROM PUBLIC`);
            await adminClient.query(`GRANT CONNECT ON DATABASE ${databaseIdentifier} TO ${roleIdentifier}`);
        } finally {
            await this.releaseLockQuietly(adminClient, lockKey, 'shadow database');
            await adminClient.end().catch(() => undefined);
        }

        const adminUrl = new URL(this.configService.getOrThrow<string>('database.provisioningUrl'));
        const host = adminUrl.hostname;
        const port = adminUrl.port ? parseInt(adminUrl.port, 10) : 5432;
        this.shadowDatabaseUrlCache = this.buildDatabaseUrl(host, port, shadowDbName, shadowRole, shadowPassword);
        return this.shadowDatabaseUrlCache;
    }

    /**
     * CONCURRENCY FIX (GEN-004): the shadow database is shared, and `prisma migrate diff` resets
     * it. Two diffs running at the same time (two workers, two orchestrator instances) would
     * corrupt each other's result. The callback runs while holding a cluster-wide advisory lock.
     */
    async withShadowDatabaseLock<T>(fn: () => Promise<T>): Promise<T> {
        const serverName = this.configService.getOrThrow<string>('app.serverName');
        const lockKey = `${serverName}:shadow-database:diff`;
        const adminClient = this.getAdminClient({ statementTimeout: false });
        await adminClient.connect();
        try {
            await this.acquireLock(adminClient, lockKey);
            return await fn();
        } finally {
            await this.releaseLockQuietly(adminClient, lockKey, 'shadow diff');
            await adminClient.end().catch(() => undefined);
        }
    }

    private getAdminClient(options: { statementTimeout?: boolean } = {}): Client {
        const connectionString = this.configService.getOrThrow<string>('database.provisioningUrl');
        return new Client({
            connectionString,
            connectionTimeoutMillis: ADMIN_CONNECTION_TIMEOUT_MS,
            ...(options.statementTimeout === false ? {} : { statement_timeout: ADMIN_STATEMENT_TIMEOUT_MS }),
        });
    }
}
