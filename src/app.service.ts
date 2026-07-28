import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

@Injectable()
export class AppService {

    constructor(private readonly prisma: PrismaService) {}

    getInfo() {

        return {
            name: 'back-os-api',
            version: '0.1.0',
            environment: process.env.NODE_ENV ?? 'development',
        };

    }

    async getHealth() {

        const startedAt = Date.now();

        let databaseStatus: 'ok' | 'error' = 'ok';

        try {
            await this.prisma.$queryRaw`SELECT 1`;
        } catch {
            databaseStatus = 'error';
        }

        return {
            status: databaseStatus === 'ok' ? 'ok' : 'degraded',
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            database: databaseStatus,
            responseTimeMs: Date.now() - startedAt,
        };

    }
    
}