import {
    Injectable, NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prismamodels/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateFieldDto } from './dto/create-field.dto';
import { UpdateFieldDto } from './dto/update-field.dto';
import { toSqlIdentifier } from '../common/utils/sql-identifier.util';
import { PERMISSIONS } from '../common/constants/permissions.constant';

type Actor = { userId: string; permissions: string[] };

const LOCKED_STATUSES = ['ACTIVE', 'GENERATING'];

@Injectable()
export class FieldsService {

    constructor(private readonly prisma: PrismaService) {}

    async list(actor: Actor, platformId: string, entityId: string, includeArchived = false) {
        await this.assertCanView(actor, platformId);
        await this.findEntityOrThrow(platformId, entityId);

        return this.prisma.field.findMany({
            where: { entityId, ...(includeArchived ? {} : { isArchived: false }) },
            orderBy: { order: 'asc' },
        });
    }

    async create(actor: Actor, platformId: string, entityId: string, dto: CreateFieldDto) {
        await this.assertCanEdit(actor, platformId, PERMISSIONS.FIELD_CREATE);
        await this.findEntityOrThrow(platformId, entityId);

        const column = await this.generateUniqueColumn(entityId, dto.name);
        const order = await this.prisma.field.count({ where: { entityId } });

        return this.prisma.field.create({
            data: {
                entityId,
                name: dto.name,
                column,
                type: dto.type,
                required: dto.required ?? false,
                unique: dto.unique ?? false,
                defaultValue: dto.defaultValue,
                config: dto.config as Prisma.InputJsonValue | undefined,
                order,
            },
        });
    }

    async update(actor: Actor, platformId: string, entityId: string, fieldId: string, dto: UpdateFieldDto) {
        const platform = await this.assertCanEdit(actor, platformId, PERMISSIONS.FIELD_UPDATE);
        await this.findEntityOrThrow(platformId, entityId);
        const field = await this.findFieldOrThrow(entityId, fieldId);

        if (dto.type && dto.type !== field.type && LOCKED_STATUSES.includes(platform.status)) {
            throw new BadRequestException(
                'Impossible de changer le type : cette plateforme a déjà été générée. Supprime puis recrée le champ si besoin.',
            );
        }

        return this.prisma.field.update({
            where: { id: field.id },
            data: {
                ...dto,
                config: dto.config as Prisma.InputJsonValue | undefined,
            },
        });
    }

    async archive(actor: Actor, platformId: string, entityId: string, fieldId: string) {
        await this.assertCanEdit(actor, platformId, PERMISSIONS.FIELD_DELETE);
        await this.findEntityOrThrow(platformId, entityId);
        const field = await this.findFieldOrThrow(entityId, fieldId);

        if (field.isArchived) throw new BadRequestException('Ce champ est déjà archivé.');
        return this.prisma.field.update({ where: { id: field.id }, data: { isArchived: true } });
    }

    async restore(actor: Actor, platformId: string, entityId: string, fieldId: string) {
        await this.assertCanEdit(actor, platformId, PERMISSIONS.FIELD_DELETE);
        await this.findEntityOrThrow(platformId, entityId);
        const field = await this.findFieldOrThrow(entityId, fieldId);

        if (!field.isArchived) throw new BadRequestException("Ce champ n'est pas archivé.");
        return this.prisma.field.update({ where: { id: field.id }, data: { isArchived: false } });
    }

    async delete(actor: Actor, platformId: string, entityId: string, fieldId: string) {
        await this.assertCanDelete(actor, platformId, PERMISSIONS.FIELD_DELETE);
        await this.findEntityOrThrow(platformId, entityId);
        const field = await this.findFieldOrThrow(entityId, fieldId);

        await this.prisma.field.delete({ where: { id: field.id } });
        return { message: 'Champ supprimé définitivement.' };
    }

    // ---- Helpers ----

    private async findPlatformOrThrow(platformId: string) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Plateforme introuvable.');
        return platform;
    }

    private async findEntityOrThrow(platformId: string, entityId: string) {
        const entity = await this.prisma.entity.findFirst({ where: { id: entityId, platformId } });
        if (!entity) throw new NotFoundException('Entité introuvable.');
        return entity;
    }

    private async findFieldOrThrow(entityId: string, fieldId: string) {
        const field = await this.prisma.field.findFirst({ where: { id: fieldId, entityId } });
        if (!field) throw new NotFoundException('Champ introuvable.');
        return field;
    }

    private async getMembership(userId: string, platformId: string) {
        return this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId, userId } },
        });
    }

    // Lecture : ouverte à tout membre (VIEWER inclus), au owner, ou à un admin système global.
    private async assertCanView(actor: Actor, platformId: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.PLATFORM_READ)) return;

        const membership = await this.getMembership(actor.userId, platformId);
        if (!membership) throw new NotFoundException('Plateforme introuvable.');
    }

    // Créer / éditer / archiver : owner, admin système global, OU membre ADMIN de la plateforme.
    private async assertCanEdit(actor: Actor, platformId: string, permission: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        if (platform.ownerId === actor.userId) return platform;
        if (actor.permissions.includes(permission)) return platform;

        const membership = await this.getMembership(actor.userId, platformId);
        if (membership?.role === 'ADMIN') return platform;

        throw new ForbiddenException(
            'Tu dois être propriétaire, administrateur de la plateforme, ou avoir la permission requise.',
        );
    }

    // Supprimer définitivement : owner ou admin système global UNIQUEMENT.
    // Un ADMIN de plateforme n'y a jamais accès, même avec field.delete côté plateforme -> archive à la place.
    private async assertCanDelete(actor: Actor, platformId: string, permission: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        if (platform.ownerId === actor.userId) return platform;
        if (actor.permissions.includes(permission)) return platform;

        throw new ForbiddenException(
            'Seul le propriétaire de la plateforme peut supprimer définitivement. Tu peux archiver à la place.',
        );
    }

    private async generateUniqueColumn(entityId: string, name: string): Promise<string> {
        const base = toSqlIdentifier(name, 'field');
        let candidate = base;
        let counter = 2;
        while (
            await this.prisma.field.findUnique({ where: { entityId_column: { entityId, column: candidate } } })
        ) {
            candidate = `${base}_${counter}`;
            counter++;
        }
        return candidate;
    }
}