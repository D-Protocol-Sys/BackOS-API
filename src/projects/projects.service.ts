import {
    Injectable,
    NotFoundException,
    ForbiddenException,
    BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FilesService } from '../files/files.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { slugify } from '../common/utils/slugify.util';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import { ProjectStatus } from '@prismamodels/client';

/**
 * Type defining the requesting user (actor) details, including ID and global system permissions.
 */
type Actor = { userId: string; permissions: string[] };

/**
 * Domain Service managing the lifecycle of Projects - product/feature ideas someone intends
 * to build and sell. A Project is intentionally lightweight compared to Platform: it has no
 * membership table of its own, just an optional single manager, so access control here is
 * simpler than `PlatformsService` (manager-or-global-permission, not a weighted role hierarchy).
 */
@Injectable()
export class ProjectsService {

    constructor(
        private readonly prisma: PrismaService,
        private readonly filesService: FilesService,
    ) {}

    /**
     * Creates a new project. The creating user becomes the manager by default unless a
     * different `managerId` is explicitly provided.
     */
    async create(actor: Actor, dto: CreateProjectDto) {

        this.assertDatesAreConsistent(dto.startAt, dto.targetEndAt);

        if (dto.platformId) {
            await this.findPlatformOrThrow(dto.platformId);
        }

        const client = dto.clientId ? await this.findClientOrThrow(dto.clientId) : null;
        const contract = dto.contractId ? await this.findContractOrThrow(dto.contractId) : null;
        this.assertClientContractConsistency({ platformId: dto.platformId, client, contract });

        const managerId = dto.managerId ?? actor.userId;
        await this.assertUserExists(managerId);

        const slug = dto.name ? await this.generateUniqueSlug(dto.name) : undefined;

        return this.prisma.project.create({
            data: {
                name: dto.name,
                slug,
                description: dto.description,
                status: dto.status ?? ProjectStatus.PLANNED,
                platformId: dto.platformId,
                clientId: dto.clientId,
                contractId: dto.contractId,
                managerId,
                startAt: dto.startAt ? new Date(dto.startAt) : undefined,
                targetEndAt: dto.targetEndAt ? new Date(dto.targetEndAt) : undefined,
                priority: dto.priority,
            },
        });
    }

    /**
     * Lists projects visible to the actor.
     * Actors with the global `PROJECT_READ` permission see every project; everyone else only
     * sees projects they manage. Supports optional filtering by platform and status.
     */
    async list(actor: Actor, filters: { platformId?: string; status?: ProjectStatus } = {}) {

        const canSeeAll = actor.permissions.includes(PERMISSIONS.PROJECT_READ);

        return this.prisma.project.findMany({
            where: {
                ...(filters.platformId ? { platformId: filters.platformId } : {}),
                ...(filters.status ? { status: filters.status } : {}),
                ...(canSeeAll ? {} : { managerId: actor.userId }),
            },
            orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        });
    }

    /**
     * Retrieves a single project by ID after verifying the actor has read access to it.
     */
    async getById(actor: Actor, id: string) {
        const project = await this.prisma.project.findUnique({
            where: { id },
            include: { files: true },
        });
        if (!project) throw new NotFoundException('Project not found.');
        this.assertCanView(actor, project);
        return project;
    }

    /**
     * Updates project details. Reserved for the project's manager or a global
     * `PROJECT_UPDATE` permission holder.
     *
     * Educational note: flipping `status` to/from `COMPLETED` automatically manages
     * `completedAt` so callers don't have to remember to stamp/clear it by hand on every
     * status-changing request.
     */
    async update(actor: Actor, id: string, dto: UpdateProjectDto) {
        const project = await this.findProjectOrThrow(id);
        this.assertManagerOrGlobalPermission(actor, project, PERMISSIONS.PROJECT_UPDATE);

        this.assertDatesAreConsistent(
            dto.startAt ?? project.startAt?.toISOString(),
            dto.targetEndAt ?? project.targetEndAt?.toISOString(),
        );

        if (dto.platformId) {
            await this.findPlatformOrThrow(dto.platformId);
        }
        if (dto.managerId) {
            await this.assertUserExists(dto.managerId);
        }

        // Resolve the EFFECTIVE post-update values (a PATCH may only touch one of the three
        // fields at a time) before re-checking platform/client/contract consistency - checking
        // against `dto` alone would miss e.g. a `clientId` change that now conflicts with a
        // `platformId` the caller didn't even mention in this particular request.
        const effectivePlatformId = dto.platformId === null ? null : dto.platformId ?? project.platformId ?? undefined;
        const effectiveClientId = dto.clientId === null ? null : dto.clientId ?? project.clientId ?? undefined;
        const effectiveContractId = dto.contractId === null ? null : dto.contractId ?? project.contractId ?? undefined;

        const client = effectiveClientId ? await this.findClientOrThrow(effectiveClientId) : null;
        const contract = effectiveContractId ? await this.findContractOrThrow(effectiveContractId) : null;
        this.assertClientContractConsistency({
            platformId: effectivePlatformId ?? undefined,
            client,
            contract,
        });

        let completedAt = project.completedAt;
        if (dto.status && dto.status !== project.status) {
            if (dto.status === ProjectStatus.COMPLETED) {
                completedAt = completedAt ?? new Date();
            } else {
                completedAt = null;
            }
        }

        return this.prisma.project.update({
            where: { id },
            data: {
                name: dto.name,
                description: dto.description,
                status: dto.status,
                platformId: dto.platformId === null ? null : dto.platformId,
                clientId: dto.clientId === null ? null : dto.clientId,
                contractId: dto.contractId === null ? null : dto.contractId,
                managerId: dto.managerId === null ? null : dto.managerId,
                startAt: dto.startAt ? new Date(dto.startAt) : undefined,
                targetEndAt: dto.targetEndAt ? new Date(dto.targetEndAt) : undefined,
                priority: dto.priority,
                completedAt,
            },
        });
    }

    /**
     * Permanently deletes a project. Reserved for the project's manager or a global
     * `PROJECT_DELETE` permission holder. Its attached files (if any - see `FileAsset.
     * projectId`) are purged first, disk and database, via `FilesService.purgeFilesForParent()`
     * - otherwise they would just have `projectId` set to `null` (the schema's
     * `onDelete: SetNull`) and linger on disk forever with no owner.
     */
    async delete(actor: Actor, id: string) {
        const project = await this.findProjectOrThrow(id);
        this.assertManagerOrGlobalPermission(actor, project, PERMISSIONS.PROJECT_DELETE);

        await this.filesService.purgeFilesForParent({ projectId: id });
        await this.prisma.project.delete({ where: { id } });
        return { message: 'Project deleted.' };
    }

    // ---- Helpers ----

    /**
     * Helper retrieving a project entity or throwing a 404 exception.
     */
    private async findProjectOrThrow(id: string) {
        const project = await this.prisma.project.findUnique({ where: { id } });
        if (!project) throw new NotFoundException('Project not found.');
        return project;
    }

    /**
     * Helper verifying a target platform exists before linking a project to it.
     */
    private async findPlatformOrThrow(platformId: string) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new BadRequestException('Target platform not found.');
        return platform;
    }

    /**
     * Helper verifying a target client exists before linking a project to it.
     */
    private async findClientOrThrow(clientId: string) {
        const client = await this.prisma.client.findUnique({ where: { id: clientId } });
        if (!client) throw new BadRequestException('Target client not found.');
        return client;
    }

    /**
     * Helper verifying a target contract exists before linking a project to it.
     */
    private async findContractOrThrow(contractId: string) {
        const contract = await this.prisma.clientContract.findUnique({ where: { id: contractId } });
        if (!contract) throw new BadRequestException('Target contract not found.');
        return contract;
    }

    /**
     * Enforces two cross-entity invariants the schema itself cannot express (multiple
     * independent nullable FKs, no way to declare "these must agree" in Prisma):
     *
     *   1. If the project is linked to both a platform and a client, that client must either
     *      be platform-agnostic (`Client.platformId === null`, a client not scoped to any one
     *      platform) or belong to that exact same platform. Without this, nothing would stop a
     *      project for platform A from billing a client that only makes sense in the context of
     *      platform B.
     *   2. If the project is linked to both a client and a contract, the contract must belong
     *      to that same client - a contract is meaningless attached to a different client than
     *      the one it was actually signed with.
     *
     * Called from both `create()` and `update()` with the EFFECTIVE post-write values (not
     * just whatever the current request happens to mention), so a partial update that only
     * changes one of the three fields still gets checked against the other two as they already
     * stand on the project.
     */
    private assertClientContractConsistency(params: {
        platformId?: string;
        client: { id: string; platformId: string | null } | null;
        contract: { id: string; clientId: string } | null;
    }): void {
        const { platformId, client, contract } = params;

        if (platformId && client && client.platformId && client.platformId !== platformId) {
            throw new BadRequestException(
                'This client belongs to a different platform than the one this project is linked to.',
            );
        }

        if (client && contract && contract.clientId !== client.id) {
            throw new BadRequestException('This contract does not belong to the linked client.');
        }
    }

    /**
     * Helper verifying a target manager account exists before assigning it.
     */
    private async assertUserExists(userId: string) {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user) throw new BadRequestException('Target manager not found.');
        return user;
    }

    /**
     * Asserts actor has read access: the project's manager, or a global `PROJECT_READ` holder.
     */
    private assertCanView(actor: Actor, project: { managerId: string | null }) {
        if (project.managerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.PROJECT_READ)) return;
        throw new NotFoundException('Project not found.');
    }

    /**
     * Asserts action is executed by the project's manager or an actor with the given global
     * permission.
     */
    private assertManagerOrGlobalPermission(
        actor: Actor,
        project: { managerId: string | null },
        globalPermission: string,
    ) {
        if (project.managerId === actor.userId) return;
        if (actor.permissions.includes(globalPermission)) return;
        throw new ForbiddenException('Action reserved for the project manager.');
    }

    /**
     * Ensures a project's planned start date is not after its target end date, when both are
     * present.
     */
    private assertDatesAreConsistent(startAt?: string, targetEndAt?: string) {
        if (!startAt || !targetEndAt) return;
        if (new Date(startAt).getTime() > new Date(targetEndAt).getTime()) {
            throw new BadRequestException('startAt must not be after targetEndAt.');
        }
    }

    /**
     * Generates a URL-friendly slug from the project name. Unlike `Platform.slug`, `Project.slug`
     * is not unique in the schema, but we still avoid pointless collisions where practical.
     */
    private async generateUniqueSlug(name: string): Promise<string> {
        const base = slugify(name);
        let candidate = base;
        let counter = 2;
        while (await this.prisma.project.findFirst({ where: { slug: candidate } })) {
            candidate = `${base}-${counter}`;
            counter++;
        }
        return candidate;
    }

}
