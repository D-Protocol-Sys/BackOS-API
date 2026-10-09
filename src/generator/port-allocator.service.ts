import { Injectable, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PortAllocatorService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly configService: ConfigService,
    ) {}

    /**
     * Fetches an existing port for a platform or allocates the first available port in range.
     * * Educational Note: 
     * We load existing assigned ports into a Set to achieve O(1) membership lookup efficiency.
     * This avoids nested array lookups during iteration.
     */
    async getOrAllocatePort(platformId: string): Promise<number> {
        const platform = await this.prisma.platform.findUniqueOrThrow({ where: { id: platformId } });
        if (platform.generatedPort) return platform.generatedPort;

        const rangeStart = this.configService.get<number>('GENERATION_PORT_RANGE_START', 4100);
        const rangeEnd = this.configService.get<number>('GENERATION_PORT_RANGE_END', 4999);

        // Fetch all assigned ports to calculate available slots in memory
        const usedPorts = await this.prisma.platform.findMany({
            where: { generatedPort: { not: null } },
            select: { generatedPort: true },
        });
        const usedSet = new Set(usedPorts.map((p) => p.generatedPort));

        // Find the lowest available port within the configured network port range
        // CONCURRENCY FIX (DB-004): `generatedPort` is now UNIQUE in the database. If another
        // allocation grabbed the same port in between (P2002), the next free one is tried.
        for (let port = rangeStart; port <= rangeEnd; port++) {
            if (usedSet.has(port)) continue;
            try {
                await this.prisma.platform.update({
                    where: { id: platformId },
                    data: { generatedPort: port },
                });
                return port;
            } catch (error) {
                if ((error as { code?: string })?.code === 'P2002') {
                    usedSet.add(port);
                    continue;
                }
                throw error;
            }
        }

        throw new ConflictException('No available ports found in the reserved range.');
    }
}