import { registerAs } from '@nestjs/config';

/**
 * Database Configuration Namespace ('database')
 * * Groups all PostgreSQL connection settings into a single namespace.
 * Accessible via `ConfigService.get('database.property')`.
 */
export default registerAs('database', () => ({

    /**
     * Primary Application Database Connection URL.
     * Used by Prisma / TypeORM for standard application queries and migrations.
     * * Format: postgresql://<user>:<password>@<host>:<port>/<database_name>?schema=<schema>
     */
    url: process.env.DATABASE_URL,

    /**
     * Provisioning / Administrative Database Connection URL.
     * Connects with elevated privileges (e.g., to the default 'postgres' database) 
     * to dynamically create or manage tenant databases and database users.
     */
    provisioningUrl: process.env.DATABASE_PROVISIONING_URL,

}));