import { PlatformAccessService } from '../platforms/platform-access.service';
import { PLATFORM_PERMISSIONS } from '../common/constants/platform-permissions.constant';
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
import { CryptoService } from '../common/services/crypto.service';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import { generateSecureToken } from '../common/utils/token.util';
import { isExternalUsersEnabled } from './service-catalog/blueprints/auth-user.prisma-models';
import {
    PROFILE_FIELDS_CONFIG_KEY,
    ProfileFieldDefinition,
    buildProfileFieldDefinitions,
    readProfileFields,
} from './service-catalog/profile-fields.util';
import { SetProfileFieldsDto } from './dto/set-profile-fields.dto';

type Actor = { userId: string; permissions: string[] };
type ServiceConfig = Record<string, unknown>;

// Same rule as FieldsService: once the platform's database exists, a column's shape cannot be
// changed in place.
const LOCKED_STATUSES = ['ACTIVE', 'GENERATING'];

@Injectable()
export class PlatformServicesService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly catalog: ServiceCatalog,
        private readonly configService: ConfigService,
        private readonly cryptoService: CryptoService,
        private readonly access: PlatformAccessService,
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

        // Validate complete structure against catalog specifications, then coerce typed values
        // ("true" -> true) so what is stored - and read back by the generators - is always well-typed.
        this.catalog.validateConfig(serviceKey, fullConfig);
        // SEC-026: the JWT secret of a generated backend signs its users' sessions.
        if (
            serviceKey === 'auth-user' &&
            typeof fullConfig.jwtSecret === 'string' &&
            fullConfig.jwtSecret.length < 32
        ) {
            throw new BadRequestException('The JWT secret must be at least 32 characters long.');
        }
        const providedConfig = this.catalog.normalizeConfig(serviceKey, fullConfig);

        // Business Rule: every service this one depends on (e.g. Mailing for Auth & User and for
        // Scheduler) must already be active on the platform.
        await this.assertDependenciesActive(platformId, serviceKey);

        // Business Rule: Mailing can optionally protect /mail/send with Auth & User, which must then be active.
        if (serviceKey === 'mailing' && providedConfig.requiresAuth === true) {
            const authUserService = await this.prisma.platformService.findUnique({
                where: { platformId_serviceKey: { platformId, serviceKey: 'auth-user' } },
                select: { serviceKey: true },
            });

            if (!authUserService) {
                throw new BadRequestException(
                    'Please enable "Auth & User" before enabling authentication protection on /mail/send.',
                );
            }
        }

        // Internal (`system`) settings are never supplied by the caller: carry over what is already
        // stored (e.g. the profile fields), and generate once what must exist (e.g. the internal
        // key BackOS shares with the generated backend to authenticate its verification calls).
        const existingConfig = await this.readExistingConfig(platformId, serviceKey);
        const systemValues: ServiceConfig = {};
        for (const field of this.catalog.getByKey(serviceKey).configFields.filter((f) => f.system)) {
            const current = existingConfig[field.key];
            if (current !== undefined) systemValues[field.key] = current;
            else if (field.autoGenerate) systemValues[field.key] = generateSecureToken(32);
        }

        const { plain, secret } = this.catalog.splitConfig(serviceKey, { ...providedConfig, ...systemValues });
        const encryptionKey = this.configService.getOrThrow<string>('ENCRYPTION_KEY');
        const hasSecrets = Object.keys(secret).length > 0;
        const encryptedConfig = hasSecrets
            ? this.cryptoService.encryptWithRawKey(JSON.stringify(secret), encryptionKey)
            : null;

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

        // A service others rely on cannot be switched off underneath them (e.g. Mailing while
        // Auth & User or Scheduler are active) - the next generation would fail to compile.
        const dependentKeys = this.catalog.getDependents(serviceKey).map((blueprint) => blueprint.key);
        if (dependentKeys.length > 0) {
            const activeDependents = await this.prisma.platformService.findMany({
                where: { platformId, serviceKey: { in: dependentKeys } },
                select: { serviceKey: true },
            });
            if (activeDependents.length > 0) {
                const names = activeDependents.map((d) => `"${this.catalog.getByKey(d.serviceKey).name}"`).join(', ');
                const plural = activeDependents.length > 1;
                throw new BadRequestException(
                    `Cannot disable "${this.catalog.getByKey(serviceKey).name}": ${names} ${plural ? 'depend' : 'depends'} on it. Disable ${plural ? 'them' : 'it'} first.`,
                );
            }
        }

        // Mailing can be protected by Auth & User (its `requiresAuth` option) - same reasoning.
        if (serviceKey === 'auth-user') {
            const mailingConfig = await this.readExistingConfig(platformId, 'mailing');
            if (mailingConfig.requiresAuth === true || mailingConfig.requiresAuth === 'true') {
                throw new BadRequestException(
                    'Cannot disable "Auth & User": Mailing protects /mail/send with it. Turn that option off on Mailing first.',
                );
            }
        }

        const result = await this.prisma.platformService.deleteMany({
            where: { platformId, serviceKey },
        });

        if (result.count === 0) {
            throw new NotFoundException('This service is not currently active on this platform.');
        }

        return { message: `Service "${serviceKey}" disabled successfully.` };
    }

    /**
     * Profile fields currently defined for external users of the platform's generated backend.
     */
    async getProfileFields(actor: Actor, platformId: string) {
        await this.assertCanView(actor, platformId);

        const config = await this.getPublicConfig(platformId, 'auth-user').catch(() => null);
        if (!config) {
            throw new BadRequestException('Auth & User is not enabled on this platform.');
        }

        return {
            externalUsersEnabled: isExternalUsersEnabled(config),
            fields: readProfileFields(config),
        };
    }

    /**
     * Defines (replaces) the profile fields external users fill in after creating their account.
     * Only possible once Auth & User is enabled WITH external users. The change reaches the
     * generated backend at the next generation.
     */
    async setProfileFields(actor: Actor, platformId: string, dto: SetProfileFieldsDto) {
        await this.assertCanEdit(actor, platformId, PERMISSIONS.PLATFORM_UPDATE);

        const record = await this.prisma.platformService.findUnique({
            where: { platformId_serviceKey: { platformId, serviceKey: 'auth-user' } },
            select: { config: true },
        });
        if (!record) {
            throw new BadRequestException('Please enable "Auth & User" first.');
        }

        const config = this.normalizeConfig(record.config);
        if (!isExternalUsersEnabled(config)) {
            throw new BadRequestException(
                'External users are not enabled: re-enable "Auth & User" with "allowExternalUsers" turned on before defining a profile.',
            );
        }

        const fields = buildProfileFieldDefinitions(dto.fields);

        // A column whose type or list-ness changes cannot be altered in place once the database exists
        // (same rule as entity fields) - the next generation's migration would fail.
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId }, select: { status: true } });
        if (platform && LOCKED_STATUSES.includes(platform.status)) {
            const previous = new Map<string, ProfileFieldDefinition>(
                readProfileFields(config).map((f) => [f.column, f]),
            );
            for (const field of fields) {
                const before = previous.get(field.column);
                if (before && (before.type !== field.type || before.isArray !== field.isArray)) {
                    throw new BadRequestException(
                        `Cannot change the type of the profile field "${field.name}": this platform has already been generated. Remove it and add a new one instead.`,
                    );
                }
            }
        }

        await this.prisma.platformService.update({
            where: { platformId_serviceKey: { platformId, serviceKey: 'auth-user' } },
            data: { config: { ...config, [PROFILE_FIELDS_CONFIG_KEY]: fields } as unknown as Prisma.InputJsonValue },
        });

        return { fields, message: 'Profile fields saved. Generate the platform again to apply them.' };
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
            const decrypted = this.cryptoService.decryptWithRawKey(record.encryptedConfig, encryptionKey);
            decryptedSecret = JSON.parse(decrypted);
        } catch {
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
     * Throws a clear 400 when a prerequisite service of `serviceKey` is not active on the platform.
     */
    private async assertDependenciesActive(platformId: string, serviceKey: string): Promise<void> {
        const dependencies = this.catalog.getDependencies(serviceKey);
        if (dependencies.length === 0) return;

        const active = await this.prisma.platformService.findMany({
            where: { platformId, serviceKey: { in: dependencies.map((d) => d.key) } },
            select: { serviceKey: true },
        });
        const activeKeys = new Set(active.map((row) => row.serviceKey));
        const missing = dependencies.filter((d) => !activeKeys.has(d.key));

        if (missing.length > 0) {
            const names = missing.map((d) => `"${d.name}"`).join(', ');
            throw new BadRequestException(
                `"${this.catalog.getByKey(serviceKey).name}" requires ${names} to be enabled first.`,
            );
        }
    }

    /**
     * Current stored configuration (plain + decrypted secrets) or `{}` when the service is not yet active.
     */
    private async readExistingConfig(platformId: string, serviceKey: string): Promise<ServiceConfig> {
        try {
            return await this.getFullDecryptedConfig(platformId, serviceKey);
        } catch (error) {
            if (error instanceof NotFoundException) return {};
            throw error;
        }
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
        return config;
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

        // Platform-level check: ADMIN implicitly, or a custom role carrying `platform.update`
        // (enabling/configuring a service is a change to the platform's own configuration).
        const { permissions } = await this.access.getEffectivePermissions(actor, platform);
        if (permissions.has(PLATFORM_PERMISSIONS.PLATFORM_UPDATE)) return;

        throw new ForbiddenException(
            'You must be the owner, a platform administrator, or possess required permissions.',
        );
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
