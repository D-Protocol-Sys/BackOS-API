import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaClient } from '@prismamodels/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Service extending `PrismaClient` to handle database connections and query operations.
 * Implements NestJS lifecycle hooks (`OnModuleInit`, `OnModuleDestroy`) to manage 
 * database connection pooling smoothly during application startup and shutdown.
 */
@Injectable()
export class PrismaService
    extends PrismaClient
    implements OnModuleInit, OnModuleDestroy
{
    private readonly logger = new Logger(PrismaService.name);

    /**
     * Initializes `PrismaClient` using the PostgreSQL driver adapter (`PrismaPg`).
     * Connection string is dynamically read from environment variables.
     */
    constructor() {
        // DB-009: the pool size is explicit and tunable (DATABASE_POOL_MAX, default 10) instead of
        // relying on the driver default, so several replicas can be sized against
        // PostgreSQL's max_connections.
        const poolMax = Number.parseInt(process.env.DATABASE_POOL_MAX ?? '', 10);
        const adapter = new PrismaPg({
            connectionString: process.env.DATABASE_URL,
            max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : 10,
            connectionTimeoutMillis: 10_000,
            idleTimeoutMillis: 30_000,
        });

        super({ adapter });
    }

    /**
     * NestJS Lifecycle Hook triggered when the host module initializes.
     * Establishes the active connection to the database.
     */
    async onModuleInit() {
        await this.$connect();
        this.logger.log('Successfully connected to the database');
    }

    /**
     * NestJS Lifecycle Hook triggered when the host module is destroyed.
     * Gracefully closes all database connection pools.
     */
    async onModuleDestroy() {
        await this.$disconnect();
    }
}