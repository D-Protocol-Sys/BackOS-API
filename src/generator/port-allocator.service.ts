import { Injectable, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PortAllocatorService {

    constructor(
        private readonly prisma: PrismaService,
        private readonly configService: ConfigService,
    ) {}

    async getOrAllocatePort(platformId: string): Promise<number> {
        const platform = await this.prisma.platform.findUniqueOrThrow({ where: { id: platformId } });
        if (platform.generatedPort) return platform.generatedPort;

        const rangeStart = this.configService.get<number>('GENERATION_PORT_RANGE_START', 4100);
        const rangeEnd = this.configService.get<number>('GENERATION_PORT_RANGE_END', 4999);

        const usedPorts = await this.prisma.platform.findMany({
            where: { generatedPort: { not: null } },
            select: { generatedPort: true },
        });
        const usedSet = new Set(usedPorts.map((p) => p.generatedPort));

        for (let port = rangeStart; port <= rangeEnd; port++) {
            if (!usedSet.has(port)) {
                await this.prisma.platform.update({ where: { id: platformId }, data: { generatedPort: port } });
                return port;
            }
        }

        throw new ConflictException('Aucun port disponible dans la plage réservée à la génération.');
    }
}