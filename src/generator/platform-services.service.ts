import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prismamodels/client';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { ServiceCatalog } from './service-catalog/service-catalog';
import { encrypt, decrypt } from '../common/utils/encryption.util';
import { PERMISSIONS } from '../common/constants/permissions.constant';

type Actor = { userId: string; permissions: string[] };

@Injectable()
export class PlatformServicesService {

    constructor(
        private readonly prisma: PrismaService,
        private readonly catalog: ServiceCatalog,
        private readonly configService: ConfigService,
    ) {}

    async list(actor: Actor, platformId: string) {
        await this.assertCanView(actor, platformId);

        const services = await this.prisma.platformService.findMany({ where: { platformId } });

        return services.map((s) => ({
            serviceKey: s.serviceKey,
            config: s.config,
            hasSecretConfig: Boolean(s.encryptedConfig),
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
        }));
    }

    async enable(actor: Actor, platformId: string, serviceKey: string, fullConfig: Record<string, unknown>) {
        
        await this.assertCanEdit(actor, platformId, PERMISSIONS.PLATFORM_UPDATE);

        this.catalog.validateConfig(serviceKey, fullConfig);
        const { plain, secret } = this.catalog.splitConfig(serviceKey, fullConfig);

        const encryptionKey = this.configService.getOrThrow<string>('ENCRYPTION_KEY');
        const encryptedConfig =
        Object.keys(secret).length > 0 ? encrypt(JSON.stringify(secret), encryptionKey) : null;

        return this.prisma.platformService.upsert({
            where: { platformId_serviceKey: { platformId, serviceKey } },
            update: { config: plain as Prisma.InputJsonValue | undefined, encryptedConfig },
            create: { platformId, serviceKey, config: plain as Prisma.InputJsonValue | undefined, encryptedConfig },
        });
    }

    async disable(actor: Actor, platformId: string, serviceKey: string) {
        await this.assertCanEdit(actor, platformId, PERMISSIONS.PLATFORM_UPDATE);

        await this.prisma.platformService.deleteMany({ where: { platformId, serviceKey } });
        return { message: `Service "${serviceKey}" désactivé.` };
    }

    async getFullDecryptedConfig(platformId: string, serviceKey: string): Promise<Record<string, unknown>> {
        
        const record = await this.prisma.platformService.findUnique({
            where: { platformId_serviceKey: { platformId, serviceKey } },
        });
        
        if (!record) throw new NotFoundException('Service non activé sur cette plateforme.');

        const plain = (record.config as Record<string, unknown>) ?? {};
        if (!record.encryptedConfig) return plain;

        const encryptionKey = this.configService.getOrThrow<string>('ENCRYPTION_KEY');
        const secret = JSON.parse(decrypt(record.encryptedConfig, encryptionKey));
        return { ...plain, ...secret };
    }

    private async assertCanView(actor: Actor, platformId: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.PLATFORM_READ)) return;

        const membership = await this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId, userId: actor.userId } },
        });
        if (!membership) throw new NotFoundException('Plateforme introuvable.');
    }

    private async assertCanEdit(actor: Actor, platformId: string, permission: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(permission)) return;

        const membership = await this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId, userId: actor.userId } },
        });
        if (membership?.role === 'ADMIN') return;

        throw new ForbiddenException(
            'Tu dois être propriétaire, administrateur de la plateforme, ou avoir la permission requise.',
        );
    }

    private async findPlatformOrThrow(platformId: string) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Plateforme introuvable.');
        return platform;
    }
}