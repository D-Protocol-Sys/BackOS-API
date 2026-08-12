import {
    Injectable,
    BadRequestException,
    ForbiddenException,
    InternalServerErrorException,
    NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prismamodels/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ServiceCatalog } from './service-catalog/service-catalog';
import { encrypt, decrypt } from '../common/utils/encryption.util';
import { PERMISSIONS } from '../common/constants/permissions.constant';

type Actor = { userId: string; permissions: string[] };
type ServiceConfig = Record<string, unknown>;

@Injectable()
export class PlatformServicesService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly catalog: ServiceCatalog,
        private readonly configService: ConfigService,
    ) {}

    /**
     * Retrieves all enabled services for a specific platform.
     * Educational Note: We map the results to guarantee encrypted secrets are omitted 
     * from responses, returning only public metadata and plain configuration.
     */
    async list(actor: Actor, platformId: string) {
        await this.assertCanView(actor, platformId);

        const services = await this.prisma.platformService.findMany({
            where: { platformId },
            orderBy: { serviceKey: 'asc' },
            select: { serviceKey: true, config: true, encryptedConfig: true, createdAt: true, updatedAt: true },
        });

        return services.map((service) => ({
            serviceKey: service.serviceKey,
            config: service.config,
            hasSecretConfig: Boolean(service.encryptedConfig),
            createdAt: service.createdAt,
            updatedAt: service.updatedAt,
        }));
    }

    /**
     * Enables or updates a platform service configuration.
     * Educational Note: Splitting inputs into plain vs secret settings ensures sensitive data
     * (like API keys) is encrypted before persisting, maintaining zero-leak API boundaries.
     */
    async enable(actor: Actor, platformId: string, serviceKey: string, fullConfig: ServiceConfig) {
        await this.assertCanEdit(actor, platformId, PERMISSIONS.PLATFORM_UPDATE);
        this.assertValidServiceKey(serviceKey);

        if (!fullConfig || typeof fullConfig !== 'object' || Array.isArray(fullConfig)) {
            throw new BadRequestException('Invalid service configuration provided.');
        }

        // Validate complete structure against catalog specifications
        this.catalog.validateConfig(serviceKey, fullConfig);

        // Business Rule: Ensure target prerequisites exist (e.g., Mailing requires Auth & User)
        if (serviceKey === 'mailing' && fullConfig.requiresAuth === true) {
            const authUserService = await this.prisma.platformService.findUnique({
                where: { platformId_serviceKey: { platformId, serviceKey: 'auth-user' } },
                select: { serviceKey: true },
            });

            if (!authUserService) {
                throw new BadRequestException('Please enable "Auth & User" before enabling authentication protection on /mail/send.');
            }
        }

        const { plain, secret } = this.catalog.splitConfig(serviceKey, fullConfig);
        const encryptionKey = this.configService.getOrThrow<string>('ENCRYPTION_KEY');
        const hasSecrets = Object.keys(secret).length > 0;
        const encryptedConfig = hasSecrets ? encrypt(JSON.stringify(secret), encryptionKey) : null;

        const service = await this.prisma.platformService.upsert({
            where: { platformId_serviceKey: { platformId, serviceKey } },
            update: {
                config: Object.keys(plain).length > 0 ? (plain as Prisma.InputJsonValue) : undefined,
                encryptedConfig,
            },
            create: {
                platformId,
                serviceKey,
                config: Object.keys(plain).length > 0 ? (plain as Prisma.InputJsonValue) : undefined,
                encryptedConfig,
            },
            select: { serviceKey: true, config: true, encryptedConfig: true, createdAt: true, updatedAt: true },
        });

        return {
            serviceKey: service.serviceKey,
            config: service.config,
            hasSecretConfig: Boolean(service.encryptedConfig),
            createdAt: service.createdAt,
            updatedAt: service.updatedAt,
        };
    }

    /**
     * Removes an active service integration from a platform.
     */
    async disable(actor: Actor, platformId: string, serviceKey: string) {
        await this.assertCanEdit(actor, platformId, PERMISSIONS.PLATFORM_UPDATE);
        this.assertValidServiceKey(serviceKey);

        const result = await this.prisma.platformService.deleteMany({
            where: { platformId, serviceKey },
        });

        if (result.count === 0) {
            throw new NotFoundException('This service is not currently active on this platform.');
        }

        return { message: `Service "${serviceKey}" disabled successfully.` };
    }

    /**
     * Resolves complete configuration including decrypted credentials.
     * Educational Note: This internal-only method should NEVER be exposed to HTTP endpoints directly.
     * It safely catches decryption errors to prevent leaking cipher keys or stack traces.
     */
    async getFullDecryptedConfig(platformId: string, serviceKey: string): Promise<ServiceConfig> {
        this.assertValidServiceKey(serviceKey);

        const record = await this.prisma.platformService.findUnique({
            where: { platformId_serviceKey: { platformId, serviceKey } },
            select: { config: true, encryptedConfig: true },
        });

        if (!record) {
            throw new NotFoundException('Service not active on this platform.');
        }

        const plain = this.normalizeConfig(record.config);
        if (!record.encryptedConfig) return plain;

        const encryptionKey = this.configService.getOrThrow<string>('ENCRYPTION_KEY');
        let decryptedSecret: unknown;

        try {
            const decrypted = decrypt(record.encryptedConfig, encryptionKey);
            decryptedSecret = JSON.parse(decrypted);
        } catch (error) {
            // Mask detailed crypto/parsing errors behind generic internal error
            throw new InternalServerErrorException('Failed to retrieve secure service configuration.');
        }

        if (!decryptedSecret || typeof decryptedSecret !== 'object' || Array.isArray(decryptedSecret)) {
            throw new InternalServerErrorException('Invalid secure configuration payload format.');
        }

        return { ...plain, ...(decryptedSecret as ServiceConfig) };
    }

    /**
     * Returns public-facing metadata configuration without fetching or decrypting secrets.
     */
    async getPublicConfig(platformId: string, serviceKey: string): Promise<ServiceConfig> {
        this.assertValidServiceKey(serviceKey);

        const record = await this.prisma.platformService.findUnique({
            where: { platformId_serviceKey: { platformId, serviceKey } },
            select: { config: true },
        });

        if (!record) {
            throw new NotFoundException('Service not active on this platform.');
        }

        return this.normalizeConfig(record.config);
    }

    /**
     * Validates that the service key is non-empty and recognized by the catalog system.
     */
    private assertValidServiceKey(serviceKey: string): void {
        if (typeof serviceKey !== 'string' || serviceKey.trim().length === 0) {
            throw new BadRequestException('Invalid service identifier provided.');
        }

        try {
            this.catalog.getByKey(serviceKey);
        } catch {
            throw new BadRequestException(`Unknown service identifier "${serviceKey}".`);
        }
    }

    /**
     * Helper to safely sanitize unknown JSON database values into structured object maps.
     */
    private normalizeConfig(config: Prisma.JsonValue | null): ServiceConfig {
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
            return {};
        }
        return config as ServiceConfig;
    }

    /**
     * Guard verifying read access for a user/actor over a given platform.
     * Educational Note: If a user is not a member, we return a 404 instead of 403 
     * to prevent unauthorized actors from enumerating platform IDs.
     */
    private async assertCanView(actor: Actor, platformId: string): Promise<void> {
        const platform = await this.findPlatformOrThrow(platformId);

        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.PLATFORM_READ)) return;

        const membership = await this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId, userId: actor.userId } },
            select: { id: true },
        });

        if (!membership) {
            throw new NotFoundException('Platform not found.');
        }
    }

    /**
     * Guard verifying write/update authorization levels for a platform actor.
     */
    private async assertCanEdit(actor: Actor, platformId: string, permission: string): Promise<void> {
        const platform = await this.findPlatformOrThrow(platformId);

        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(permission)) return;

        const membership = await this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId, userId: actor.userId } },
            select: { role: true },
        });

        if (membership?.role === 'ADMIN') return;

        throw new ForbiddenException('You must be the owner, a platform administrator, or possess required permissions.');
    }

    /**
     * Fetches basic platform metadata or halts execution if not found.
     */
    private async findPlatformOrThrow(platformId: string) {
        const platform = await this.prisma.platform.findUnique({
            where: { id: platformId },
            select: { id: true, ownerId: true },
        });

        if (!platform) {
            throw new NotFoundException('Platform not found.');
        }

        return platform;
    }
}