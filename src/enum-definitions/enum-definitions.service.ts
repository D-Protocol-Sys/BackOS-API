import { PlatformAccessService } from '../platforms/platform-access.service';
import { PLATFORM_PERMISSIONS } from '../common/constants/platform-permissions.constant';
import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEnumDefinitionDto } from './dto/create-enum-definition.dto';
import { UpdateEnumDefinitionDto } from './dto/update-enum-definition.dto';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import { assertValidEnumValues, assertEnumValuesOnlyAppended } from '../common/utils/enum-value.util';

type Actor = { userId: string; permissions: string[] };

/** Same lock as `FieldsService`: once the platform's database exists, its shape cannot change in place. */
const LOCKED_STATUSES = ['ACTIVE', 'GENERATING'];

/**
 * Manages the reusable sets of options (`EnumDefinition`) a platform's ENUM fields pick from.
 * Authorization mirrors `FieldsService` exactly (same roles get the same rights over an enum as
 * over a field), since an enum is really just a piece of a field's shape that happens to be
 * shared across several fields.
 */
@Injectable()
export class EnumDefinitionsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly access: PlatformAccessService,
    ) {}

    async list(actor: Actor, platformId: string) {
        await this.assertCanView(actor, platformId);
        return this.prisma.enumDefinition.findMany({ where: { platformId }, orderBy: { name: 'asc' } });
    }

    async create(actor: Actor, platformId: string, dto: CreateEnumDefinitionDto) {
        await this.assertCanEdit(actor, platformId, PERMISSIONS.FIELD_CREATE);
        assertValidEnumValues(dto.values);

        const existing = await this.prisma.enumDefinition.findUnique({
            where: { platformId_name: { platformId, name: dto.name } },
        });
        if (existing) {
            throw new BadRequestException(`An enum named "${dto.name}" already exists on this platform.`);
        }

        return this.prisma.enumDefinition.create({ data: { platformId, name: dto.name, values: dto.values } });
    }

    async update(actor: Actor, platformId: string, enumDefinitionId: string, dto: UpdateEnumDefinitionDto) {
        const platform = await this.assertCanEdit(actor, platformId, PERMISSIONS.FIELD_UPDATE);
        const enumDefinition = await this.findOrThrow(platformId, enumDefinitionId);

        const nextValues = dto.values ?? enumDefinition.values;
        assertValidEnumValues(nextValues);

        if (dto.values && LOCKED_STATUSES.includes(platform.status)) {
            assertEnumValuesOnlyAppended(enumDefinition.values, dto.values);
        }

        if (dto.name && dto.name !== enumDefinition.name) {
            const collision = await this.prisma.enumDefinition.findUnique({
                where: { platformId_name: { platformId, name: dto.name } },
            });
            if (collision) {
                throw new BadRequestException(`An enum named "${dto.name}" already exists on this platform.`);
            }
        }

        return this.prisma.enumDefinition.update({
            where: { id: enumDefinitionId },
            data: { name: dto.name, values: dto.values },
        });
    }

    async delete(actor: Actor, platformId: string, enumDefinitionId: string) {
        const platform = await this.assertCanEdit(actor, platformId, PERMISSIONS.FIELD_DELETE);
        await this.findOrThrow(platformId, enumDefinitionId);

        const usedByFields = await this.prisma.field.count({ where: { enumDefinitionId, isArchived: false } });
        if (usedByFields > 0) {
            throw new BadRequestException(
                `This enum is used by ${usedByFields} field${usedByFields > 1 ? 's' : ''} - remove ${usedByFields > 1 ? 'them' : 'it'} first.`,
            );
        }
        if (LOCKED_STATUSES.includes(platform.status)) {
            throw new BadRequestException('Cannot delete an enum: this platform has already been generated.');
        }

        await this.prisma.enumDefinition.delete({ where: { id: enumDefinitionId } });
        return { message: 'Enum deleted.' };
    }

    // ---- Helpers (mirrors FieldsService's own, deliberately - same authorization boundary) ----

    private async findOrThrow(platformId: string, enumDefinitionId: string) {
        const enumDefinition = await this.prisma.enumDefinition.findFirst({
            where: { id: enumDefinitionId, platformId },
        });
        if (!enumDefinition) throw new NotFoundException('Enum not found.');
        return enumDefinition;
    }

    private async findPlatformOrThrow(platformId: string) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Platform not found.');
        return platform;
    }

    private async getMembership(userId: string, platformId: string) {
        return this.prisma.platformMember.findUnique({ where: { platformId_userId: { platformId, userId } } });
    }

    private async assertCanView(actor: Actor, platformId: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.PLATFORM_READ)) return;
        const membership = await this.getMembership(actor.userId, platformId);
        if (!membership) throw new NotFoundException('Platform not found.');
    }

    private async assertCanEdit(actor: Actor, platformId: string, permission: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        if (platform.ownerId === actor.userId) return platform;
        if (actor.permissions.includes(permission)) return platform;
        // Platform-level check: ADMIN implicitly, or a custom role carrying `field.manage`.
        const { permissions } = await this.access.getEffectivePermissions(actor, platform);
        if (permissions.has(PLATFORM_PERMISSIONS.FIELD_MANAGE)) return platform;
        throw new ForbiddenException(
            'You must be the owner, a platform administrator, or possess the required permission.',
        );
    }
}
