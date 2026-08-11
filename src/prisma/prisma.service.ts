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
        const adapter = new PrismaPg({
            connectionString: process.env.DATABASE_URL,
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