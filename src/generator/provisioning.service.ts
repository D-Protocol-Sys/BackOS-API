import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, escapeIdentifier, escapeLiteral } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/services/crypto.service';
import { platformSlugToDbName, platformSlugToDbUser, generateSecurePassword } from '../common/utils/db-identifier.util';

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

@Injectable()
export class ProvisioningService {
    private readonly logger = new Logger(ProvisioningService.name);
    private pendingPassword?: string;

    constructor(
        private readonly prisma: PrismaService,
        private readonly configService: ConfigService,
        private readonly cryptoService: CryptoService,
    ) {}

    /**
     * Provisions a dedicated, isolated PostgreSQL database for a platform.
     * Educational Note: Implements an idempotent flow using database-level advisory locks 
     * to safely prevent concurrent execution and race conditions across distributed nodes.
     */
    async provisionDatabaseForPlatform(platformId: string, slug: string): Promise<ProvisionResult> {
        const dbName = platformSlugToDbName(slug);
        const dbUser = platformSlugToDbUser(slug);
        const host = this.configService.get<string>('database.provisioningHost', 'localhost');
        const port = this.configService.get<number>('database.provisioningPort', 5432);
        const encryptionKey = this.configService.getOrThrow<string>('security.encryptionKey');
        const serverName = this.configService.getOrThrow<string>('app.serverName');

        // Fast-path idempotency check before acquiring database locks
        const existingDatabase = await this.prisma.platformDatabase.findUnique({ where: { platformId } });
        if (existingDatabase) {
            return {
                host: existingDatabase.host,
                port: existingDatabase.port,
                databaseName: existingDatabase.databaseName,
                databaseUser: existingDatabase.databaseUser,
                databaseUrl: await this.getDecryptedConnectionUrl(platformId),
            };
        }

        const adminClient = this.getAdminClient();
        await adminClient.connect();
        const lockKey = `${serverName}:provision:${platformId}`;
        const resources: ProvisioningResources = { roleCreated: false, databaseCreated: false };

        try {
            // Acquire distributed advisory lock on PostgreSQL session level
            await this.acquireLock(adminClient, lockKey);

            // Double-check existence after securing lock to eliminate race conditions
            const databaseAfterLock = await this.prisma.platformDatabase.findUnique({ where: { platformId } });
            if (databaseAfterLock) {
                return {
                    host: databaseAfterLock.host,
                    port: databaseAfterLock.port,
                    databaseName: databaseAfterLock.databaseName,
                    databaseUser: databaseAfterLock.databaseUser,
                    databaseUrl: await this.getDecryptedConnectionUrl(platformId),
                };
            }

            const roleIdentifier = escapeIdentifier(dbUser);
            const databaseIdentifier = escapeIdentifier(dbName);
            const provisionRoleName = this.configService.getOrThrow<string>('database.provisioningRole');
            const provisionRoleIdentifier = escapeIdentifier(provisionRoleName);

            // Check role existence prior to creation
            const roleResult = await adminClient.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [dbUser]);
            if (roleResult.rowCount === 0) {
                const password = generateSecurePassword();
                const passwordLiteral = escapeLiteral(password);

                await adminClient.query(`CREATE ROLE ${roleIdentifier} WITH LOGIN PASSWORD ${passwordLiteral}`);
                resources.roleCreated = true;
                this.pendingPassword = password;
            } else {
                throw new Error(`PostgreSQL role "${dbUser}" already exists without a corresponding platform database record.`);
            }

            const password = this.pendingPassword;
            this.pendingPassword = undefined;
            if (!password) {
                throw new Error('Failed to retrieve generated PostgreSQL password credentials.');
            }

            // Check database existence
            const databaseResult = await adminClient.query(
                'SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1',
                [dbName],
            );

            if (databaseResult.rowCount === 1) {
                const existingOwner = databaseResult.rows[0].owner;
                throw new Error(`PostgreSQL database "${dbName}" already exists without metadata record. Existing owner: "${existingOwner}".`);
            }

            // Temporarily grant permissions to provision database with target owner
            await adminClient.query(`GRANT ${roleIdentifier} TO ${provisionRoleIdentifier}`);

            try {
                // Note: CREATE DATABASE cannot run inside an explicit transaction block
                await adminClient.query(`CREATE DATABASE ${databaseIdentifier} OWNER ${roleIdentifier}`);
                resources.databaseCreated = true;
            } finally {
                try {
                    await adminClient.query(`REVOKE ${roleIdentifier} FROM ${provisionRoleIdentifier}`);
                } catch (revokeError) {
                    this.logger.error(
                        `Failed to temporarily revoke role "${dbUser}" from provisioning user.`,
                        revokeError instanceof Error ? revokeError.stack : String(revokeError),
                    );
                    throw revokeError;
                }
            }

            // Security Hardening: Revoke default database access from PUBLIC role
            await adminClient.query(`REVOKE ALL ON DATABASE ${databaseIdentifier} FROM PUBLIC`);

            // Persist encrypted connection credentials in system metadata
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

            // Clean up partial allocations to preserve strict system rollback semantics
            if (resources.databaseCreated || resources.roleCreated) {
                await this.cleanupCreatedResources(adminClient, dbName, dbUser, resources);
            }

            if (error instanceof InternalServerErrorException) throw error;
            throw new InternalServerErrorException('Failed to provision platform PostgreSQL infrastructure.');
        } finally {
            try {
                await this.releaseLock(adminClient, lockKey);
            } catch (unlockError) {
                this.logger.error(
                    `Failed to release provisioning advisory lock for platform "${platformId}".`,
                    unlockError instanceof Error ? unlockError.stack : String(unlockError),
                );
            }
            await adminClient.end();
        }
    }

    /**
     * Decrypts and compiles full database connection string metadata.
     */
    async getDecryptedConnectionUrl(platformId: string): Promise<string> {
        const record = await this.prisma.platformDatabase.findUniqueOrThrow({ where: { platformId } });
        const encryptionKey = this.configService.getOrThrow<string>('security.encryptionKey');
        const password = this.cryptoService.decryptWithRawKey(record.encryptedPassword, encryptionKey);

        return this.buildDatabaseUrl(record.host, record.port, record.databaseName, record.databaseUser, password);
    }

    /**
     * Deprovisions and drops target database and database role completely.
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
            try {
                await this.releaseLock(adminClient, lockKey);
            } catch (unlockError) {
                this.logger.error(
                    `Failed to release deprovisioning lock for platform "${platformId}".`,
                    unlockError instanceof Error ? unlockError.stack : String(unlockError),
                );
            }
            await adminClient.end();
        }
    }

    /**
     * Cleans up allocated resources during a failed provision attempt.
     * Educational Note: Operates strictly on resources marked as created during the current lifecycle,
     * protecting pre-existing system resources from accidental drop operations.
     */
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

    /**
     * Drops database and user role sequentially.
     */
    private async dropPlatformResources(adminClient: Client, dbName: string, dbUser: string): Promise<void> {
        await this.dropDatabase(adminClient, dbName, dbUser);
        await this.dropRole(adminClient, dbUser);
    }

    /**
     * Terminates existing backend client sessions and drops target PostgreSQL database.
     */
    private async dropDatabase(adminClient: Client, dbName: string, dbUser?: string): Promise<void> {
        const databaseIdentifier = escapeIdentifier(dbName);

        // The provisioning role's temporary membership in the target owner role is revoked
        // right after CREATE DATABASE (see provisionDatabaseForPlatform). Dropping a database
        // requires being its owner, so that membership must be re-granted first, or this fails
        // with "must be owner of database". Skipped when the role no longer exists (dbUser
        // omitted, or already dropped) since GRANT would itself fail in that case.
        if (dbUser) {
            const roleExists = await adminClient.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [dbUser]);
            if (roleExists.rowCount === 1) {
                const provisionRoleName = this.configService.getOrThrow<string>('database.provisioningRole');
                await adminClient.query(
                    `GRANT ${escapeIdentifier(dbUser)} TO ${escapeIdentifier(provisionRoleName)}`,
                );
            }
        }

        // Force termination of active database client connections
        await adminClient.query(
            'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
            [dbName],
        );
        await adminClient.query(`DROP DATABASE IF EXISTS ${databaseIdentifier}`);
    }

    /**
     * Removes target PostgreSQL user role.
     */
    private async dropRole(adminClient: Client, dbUser: string): Promise<void> {
        const roleIdentifier = escapeIdentifier(dbUser);
        await adminClient.query(`DROP ROLE IF EXISTS ${roleIdentifier}`);
    }

    /**
     * Session-level PostgreSQL advisory lock helper.
     */
    private async acquireLock(adminClient: Client, lockKey: string): Promise<void> {
        await adminClient.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    }

    /**
     * Session-level PostgreSQL advisory unlock helper.
     */
    private async releaseLock(adminClient: Client, lockKey: string): Promise<void> {
        await adminClient.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
    }

    /**
     * Constructs standard Postgres connection strings, encoding special characters and handling IPv6 hosts.
     */
    private buildDatabaseUrl(host: string, port: number, databaseName: string, databaseUser: string, password: string): string {
        const normalizedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
        return `postgresql://${encodeURIComponent(databaseUser)}:${encodeURIComponent(password)}@${normalizedHost}:${port}/${encodeURIComponent(databaseName)}?schema=public`;
    }

    private shadowDatabaseUrlCache: string | null = null;

    /**
     * Ensures a single, persistent PostgreSQL database exists purely as Prisma's scratch space
     * for `prisma migrate diff --from-migrations ...`, and returns its connection URL.
     *
     * WHY THIS EXISTS: `migrate diff` can't compute "what does this migration history result
     * in" by statically parsing arbitrary SQL files - it actually REPLAYS them against a real,
     * empty database (a "shadow" database) to find out, then diffs the result against the
     * target schema. Without one configured, it fails outright with "You must set
     * `datasource.shadowDatabaseUrl`...".
     *
     * WHY NOT `migrate dev` (which creates/drops its own shadow database automatically): that
     * requires the CONNECTING role to have `CREATEDB`, which the per-platform role from
     * `provisionDatabaseForPlatform()` deliberately does NOT have (see that method - it's
     * least-privilege by design, and that role is also what a generated backend runs with at
     * runtime). Granting CREATEDB there just to make migrations work would hand every generated
     * backend's runtime credentials the ability to create arbitrary new databases on this
     * Postgres instance - a meaningfully bigger blast radius than a schema-diffing tool needs.
     *
     * WHY ONE SHARED DATABASE (not one per platform, or one per generation): `GenerationProcessor`
     * is a BullMQ `@Processor` with no explicit `concurrency` option set, which means BullMQ
     * runs it at its default of 1 - generation jobs are processed strictly one at a time, system-
     * wide. A single shadow database can never be used by two `migrate diff` invocations at once,
     * so reusing one avoids provisioning (and leaving behind) a throwaway database per
     * generation. If that concurrency setting is ever raised, this method - and the
     * single-shared-database assumption behind it - needs revisiting first.
     *
     * Uses the SAME administrative credentials already used for `provisionDatabaseForPlatform()`
     * - the provisioning role owns this database outright, so no additional grant is needed and
     * no new credential has to be managed.
     */
    async ensureShadowDatabaseUrl(): Promise<string> {
        if (this.shadowDatabaseUrlCache) return this.shadowDatabaseUrlCache;

        const shadowDbName = this.configService.get<string>('database.shadowDatabaseName', 'backos_migration_shadow');
        const provisionRoleName = this.configService.getOrThrow<string>('database.provisioningRole');
        const serverName = this.configService.getOrThrow<string>('app.serverName');

        const adminClient = this.getAdminClient();
        await adminClient.connect();
        const lockKey = `${serverName}:shadow-database`;

        try {
            // Same advisory-lock pattern as provisionDatabaseForPlatform() - protects against
            // two orchestrator instances racing to create this database concurrently on startup.
            await this.acquireLock(adminClient, lockKey);

            const existing = await adminClient.query('SELECT 1 FROM pg_database WHERE datname = $1', [shadowDbName]);
            if (existing.rowCount === 0) {
                const databaseIdentifier = escapeIdentifier(shadowDbName);
                const provisionRoleIdentifier = escapeIdentifier(provisionRoleName);
                // Note: CREATE DATABASE cannot run inside an explicit transaction block (same
                // constraint noted in provisionDatabaseForPlatform() above).
                await adminClient.query(`CREATE DATABASE ${databaseIdentifier} OWNER ${provisionRoleIdentifier}`);
                this.logger.log(`Base de données shadow créée pour les diffs de migration : "${shadowDbName}".`);
            }
        } finally {
            await this.releaseLock(adminClient, lockKey);
            await adminClient.end();
        }

        const shadowUrl = new URL(this.configService.getOrThrow<string>('database.provisioningUrl'));
        shadowUrl.pathname = `/${encodeURIComponent(shadowDbName)}`;
        this.shadowDatabaseUrlCache = shadowUrl.toString();
        return this.shadowDatabaseUrlCache;
    }

    /**
     * Instantiates dedicated PostgreSQL client instance using configured admin URL.
     */
    private getAdminClient(): Client {
        const connectionString = this.configService.getOrThrow<string>('database.provisioningUrl');
        return new Client({ connectionString });
    }
}