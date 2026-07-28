import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PERMISSION_DESCRIPTIONS, PERMISSIONS } from '../common/constants/permissions.constant';

@Injectable()
export class PermissionsSyncService implements OnApplicationBootstrap {

    private readonly logger = new Logger(PermissionsSyncService.name);

    constructor(private readonly prisma: PrismaService) {}

    async onApplicationBootstrap() {

        const keys = Object.values(PERMISSIONS);

        for (const key of keys) {
            await this.prisma.permission.upsert({
                where: { key },
                update: { description: PERMISSION_DESCRIPTIONS[key] },
                create: { key, description: PERMISSION_DESCRIPTIONS[key] },
            });
        }

        this.logger.log(`Catalogue de permissions synchronisé (${keys.length} permissions).`);
    
    }
    
}