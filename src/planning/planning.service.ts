import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { PlanningItemType } from '@prismamodels/client';
import { PrismaService } from '../prisma/prisma.service';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import { CreatePlanningEntryDto } from './dto/create-planning-entry.dto';
import { UpdatePlanningEntryDto } from './dto/update-planning-entry.dto';

/**
 * Interface representing the authenticated actor executing the action.
 */
type Actor = { userId: string; permissions: string[] };

/**
 * Fields that participate in planning entry payload validation checks.
 */
type PlanningPayloadField = keyof CreatePlanningEntryDto;

type PlanningPayload = Partial< Record<PlanningPayloadField, unknown> >;

/**
 * Type-specific field constraint configuration.
 * Defines required and forbidden fields for each item type to enforce structural integrity.
 */
const TYPE_REQUIREMENTS: Record< PlanningItemType, {
    required: PlanningPayloadField[];
    forbidden: PlanningPayloadField[];
}> = {
    EVENT: {
        required: ['startAt', 'endAt'],
        forbidden: ['dueDate', 'targetDate', 'status'],
    },
    TASK: {
        required: ['dueDate'],
        forbidden: ['startAt', 'endAt', 'targetDate'],
    },
    NOTE: {
        required: [],
        forbidden: [
            'startAt',
            'endAt',
            'dueDate',
            'targetDate',
            'status',
        ],
    },
    MILESTONE: {
        required: ['targetDate'],
        forbidden: [
            'startAt',
            'endAt',
            'dueDate',
        ],
    },
};

/**
 * Helper function validating entry payload attributes against type-specific rules.
 * Throws a BadRequestException if required fields are missing or forbidden fields are present.
 * * @param type - The target item category (EVENT, TASK, NOTE, MILESTONE).
 * @param payload - Object containing payload fields to validate.
 */
function validatePlanningEntryPayload(
    type: PlanningItemType,
    payload: PlanningPayload,
): void {
    const rules = TYPE_REQUIREMENTS[type];

    // Ensure all mandatory fields for this item type exist
    for (const field of rules.required) {
        if (
            payload[field] === undefined ||
            payload[field] === null
        ) {
            throw new BadRequestException(
                `The field "${field}" is required for an item of type ${type}.`,
            );
        }
    }

    // Ensure no incompatible/forbidden fields are present
    for (const field of rules.forbidden) {
        if (payload[field] !== undefined) {
            throw new BadRequestException(
                `The field "${field}" is not allowed for an item of type ${type}.`,
            );
        }
    }
}

/**
 * Core business service handling personal and platform-scoped planning items,
 * assignees management, access guard assertions, and data mapping.
 */
@Injectable()
export class PlanningService {
    constructor(private readonly prisma: PrismaService) {}

    // -------------------------------------------------------------------------
    // Personal Planning Logic
    // -------------------------------------------------------------------------

    /**
     * Creates a personal planning entry bound exclusively to the authenticated user.
     */
    async createPersonal( actor: Actor, dto: CreatePlanningEntryDto ) {
        validatePlanningEntryPayload(dto.type, dto);
        return this.prisma.planningEntry.create({
            data: {
                ...this.toCreateData(dto),
                personalUserId: actor.userId,
                creatorId: actor.userId,
            },
        });
    }

    /**
     * Retrieves all personal planning entries for the active actor, with optional type filtering.
     */
    async listPersonal( actor: Actor, type?: PlanningItemType ) {
        return this.prisma.planningEntry.findMany({
            where: {
                personalUserId: actor.userId,
                ...(type ? { type } : {}),
            },
            orderBy: { createdAt: 'desc' },
            include: { attachments: true },
        });
    }

    /**
     * Retrieves a single personal planning item by ID, throwing if unauthorized or missing.
     */
    async getPersonalById( actor: Actor, id: string ) {
        const entry = await this.findEntryOrThrow(id);
        if (entry.personalUserId !== actor.userId) {
            throw new NotFoundException('Item not found.');
        }
        return entry;
    }

    /**
     * Updates an existing personal planning item after re-validating the combined payload state.
     */
    async updatePersonal( actor: Actor, id: string, dto: UpdatePlanningEntryDto ) {
        const entry = await this.getPersonalById(actor, id);
        validatePlanningEntryPayload( entry.type, { ...entry, ...dto } );
        return this.prisma.planningEntry.update({
            where: { id },
            data: this.toUpdateData(dto),
        });
    }

    /**
     * Deletes a personal planning item owned by the actor.
     */
    async deletePersonal( actor: Actor, id: string ) {
        await this.getPersonalById(actor, id);
        await this.prisma.planningEntry.delete({ where: { id } });
        return { message: 'Item deleted successfully.' };
    }

    // -------------------------------------------------------------------------
    // Platform-Scoped Planning Logic
    // -------------------------------------------------------------------------

    /**
     * Creates a new planning entry attached to a specific platform context.
     */
    async createPlatformEntry(
        actor: Actor,
        platformId: string,
        dto: CreatePlanningEntryDto,
    ) {
        await this.assertCanEditPlatformPlanning( actor, platformId );
        validatePlanningEntryPayload(dto.type, dto);
        return this.prisma.planningEntry.create({
            data: {
                ...this.toCreateData(dto),
                platformId,
                creatorId: actor.userId,
            },
        });
    }

    /**
     * Lists all planning entries within a platform, with option to filter entries assigned to actor.
     */
    async listPlatformEntries(
        actor: Actor,
        platformId: string,
        assignedToMe: boolean,
    ) {
        await this.assertCanViewPlatformPlanning( actor, platformId );
        return this.prisma.planningEntry.findMany({
            where: {
                platformId,
                ...(assignedToMe
                    ?   {
                            assignees: {
                                some: {
                                    userId: actor.userId,
                                },
                            },
                        }
                    :   {}),
            },
            orderBy: { createdAt: 'desc' },
            include: {
                attachments: true,
                assignees: {
                    include: {
                        user: {
                            select: {
                                id: true,
                                firstName: true,
                                lastName: true,
                            },
                        },
                    },
                },
            },
        });
    }

    /**
     * Updates an existing platform planning item after re-validating the updated payload.
     */
    async updatePlatformEntry(
        actor: Actor,
        platformId: string,
        id: string,
        dto: UpdatePlanningEntryDto,
    ) {
        await this.assertCanEditPlatformPlanning( actor, platformId );
        const entry = await this.findEntryInPlatformOrThrow( platformId, id );
        validatePlanningEntryPayload(
            entry.type,
            {
                ...entry,
                ...dto,
            },
        );
        return this.prisma.planningEntry.update({
            where: { id },
            data: this.toUpdateData(dto),
        });
    }

    /**
     * Deletes a planning entry from a platform.
     */
    async deletePlatformEntry(
        actor: Actor,
        platformId: string,
        id: string,
    ) {
        await this.assertCanEditPlatformPlanning( actor, platformId );
        await this.findEntryInPlatformOrThrow( platformId, id );
        await this.prisma.planningEntry.delete({ where: { id } });
        return { message: 'Item deleted successfully.' };
    }

    // -------------------------------------------------------------------------
    // Assignees Management
    // -------------------------------------------------------------------------

    /**
     * Assigns a user to a platform planning entry. Ensures target user belongs to the platform.
     */
    async addAssignee(
        actor: Actor,
        platformId: string,
        entryId: string,
        userId: string,
    ) {
        await this.assertCanEditPlatformPlanning( actor, platformId );
        await this.findEntryInPlatformOrThrow( platformId, entryId );
        const membership = await this.prisma.platformMember.findUnique({
            where: {
                platformId_userId: {
                    platformId,
                    userId,
                },
            },
        });

        const platform = await this.prisma.platform.findUniqueOrThrow({
            where: { id: platformId },
        });

        if (!membership && platform.ownerId !== userId) {
            throw new BadRequestException(
                'This user is not a member of the platform.',
            );
        }

        return this.prisma.planningEntryAssignee.upsert({
            where: {
                entryId_userId: {
                    entryId,
                    userId,
                },
            },
            update: {},
            create: { entryId, userId },
        });
    }

    /**
     * Removes an assigned user from a platform planning entry.
     */
    async removeAssignee(
        actor: Actor,
        platformId: string,
        entryId: string,
        userId: string,
    ) {
        await this.assertCanEditPlatformPlanning(
            actor,
            platformId,
        );

        await this.findEntryInPlatformOrThrow(
            platformId,
            entryId,
        );

        await this.prisma.planningEntryAssignee.deleteMany({
            where: {
                entryId,
                userId,
            },
        });

        return {
            message: 'Assignment removed successfully.',
        };
    }

    // -------------------------------------------------------------------------
    // Guard Checks (Consumed by cross-domain services, e.g., FilesService)
    // -------------------------------------------------------------------------

    /**
     * Asserts whether an actor can view a target entry (personal or platform).
     */
    async assertCanViewEntry(
        actor: Actor,
        entryId: string,
    ) {
        const entry = await this.findEntryOrThrow(entryId);

        if (entry.personalUserId) {
            if (entry.personalUserId !== actor.userId) {
                throw new ForbiddenException('Access denied.');
            }

            return;
        }

        if (entry.platformId) {
            await this.assertCanViewPlatformPlanning(
                actor,
                entry.platformId,
            );
        }
    }

    /**
     * Asserts whether an actor can edit a target entry (personal or platform).
     */
    async assertCanEditEntry(
        actor: Actor,
        entryId: string,
    ) {
        const entry = await this.findEntryOrThrow(entryId);

        if (entry.personalUserId) {
            if (entry.personalUserId !== actor.userId) {
                throw new ForbiddenException('Access denied.');
            }

            return;
        }

        if (entry.platformId) {
            await this.assertCanEditPlatformPlanning(
                actor,
                entry.platformId,
            );
        }
    }

    // -------------------------------------------------------------------------
    // Data Transformation Utilities
    // -------------------------------------------------------------------------

    /**
     * Converts creation DTO string dates into JavaScript Date objects for Prisma insertion.
     */
    private toCreateData(
        dto: CreatePlanningEntryDto,
    ) {
        return {
            type: dto.type,
            title: dto.title,
            description: dto.description,
            status: dto.status,

            startAt: dto.startAt
                ? new Date(dto.startAt)
                : undefined,

            endAt: dto.endAt
                ? new Date(dto.endAt)
                : undefined,

            dueDate: dto.dueDate
                ? new Date(dto.dueDate)
                : undefined,

            targetDate: dto.targetDate
                ? new Date(dto.targetDate)
                : undefined,
        };
    }

    /**
     * Converts update DTO fields while maintaining PATCH semantics.
     * Omitted/undefined properties are skipped to avoid overwriting existing record values.
     */
    private toUpdateData(
        dto: UpdatePlanningEntryDto,
    ) {
        return {
            ...(dto.title !== undefined && {
                title: dto.title,
            }),

            ...(dto.description !== undefined && {
                description: dto.description,
            }),

            ...(dto.status !== undefined && {
                status: dto.status,
            }),

            ...(dto.startAt !== undefined && {
                startAt: dto.startAt
                    ? new Date(dto.startAt)
                    : null,
            }),

            ...(dto.endAt !== undefined && {
                endAt: dto.endAt
                    ? new Date(dto.endAt)
                    : null,
            }),

            ...(dto.dueDate !== undefined && {
                dueDate: dto.dueDate
                    ? new Date(dto.dueDate)
                    : null,
            }),

            ...(dto.targetDate !== undefined && {
                targetDate: dto.targetDate
                    ? new Date(dto.targetDate)
                    : null,
            }),
        };
    }

    // -------------------------------------------------------------------------
    // Internal Database Query Helpers
    // -------------------------------------------------------------------------

    private async findEntryOrThrow(
        id: string,
    ) {
        const entry =
            await this.prisma.planningEntry.findUnique({
                where: {
                    id,
                },
            });

        if (!entry) {
            throw new NotFoundException(
                'Item not found.',
            );
        }

        return entry;
    }

    private async findEntryInPlatformOrThrow(
        platformId: string,
        id: string,
    ) {
        const entry =
            await this.prisma.planningEntry.findFirst({
                where: {
                    id,
                    platformId,
                },
            });

        if (!entry) {
            throw new NotFoundException(
                'Item not found.',
            );
        }

        return entry;
    }

    // -------------------------------------------------------------------------
    // Permission Verification Helpers
    // -------------------------------------------------------------------------

    /**
     * Verifies read authorization for a platform planning context.
     * Allowed: Platform Owner, Planning Read / Platform Read holders, or active platform members.
     */
    private async assertCanViewPlatformPlanning(
        actor: Actor,
        platformId: string,
    ) {
        const platform =
            await this.prisma.platform.findUnique({
                where: {
                    id: platformId,
                },
            });

        if (!platform) {
            throw new NotFoundException(
                'Platform not found.',
            );
        }

        if (platform.ownerId === actor.userId) {
            return;
        }

        if (
            actor.permissions.includes(
                PERMISSIONS.PLANNING_READ,
            )
        ) {
            return;
        }

        if (
            actor.permissions.includes(
                PERMISSIONS.PLATFORM_READ,
            )
        ) {
            return;
        }

        const membership =
            await this.prisma.platformMember.findUnique({
                where: {
                    platformId_userId: {
                        platformId,
                        userId: actor.userId,
                    },
                },
            });

        if (!membership) {
            throw new NotFoundException(
                'Platform not found.',
            );
        }
    }

    /**
     * Verifies write authorization for a platform planning context.
     * Allowed: Platform Owner, Planning Manage permission holders, or members with ADMIN role.
     */
    private async assertCanEditPlatformPlanning(
        actor: Actor,
        platformId: string,
    ) {
        const platform =
            await this.prisma.platform.findUnique({
                where: {
                    id: platformId,
                },
            });

        if (!platform) {
            throw new NotFoundException(
                'Platform not found.',
            );
        }

        if (platform.ownerId === actor.userId) {
            return;
        }

        if (
            actor.permissions.includes(
                PERMISSIONS.PLANNING_MANAGE,
            )
        ) {
            return;
        }

        const membership =
            await this.prisma.platformMember.findUnique({
                where: {
                    platformId_userId: {
                        platformId,
                        userId: actor.userId,
                    },
                },
            });

        if (membership?.role === 'ADMIN') {
            return;
        }

        throw new ForbiddenException(
            'Only a platform administrator can manage its planning.',
        );
    }
}