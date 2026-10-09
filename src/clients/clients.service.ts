import { Injectable, Logger, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService, AuditContext } from '../audit/audit-log.service';
import { FilesService } from '../files/files.service';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';
import { SubmitTestimonialDto } from './dto/submit-testimonial.dto';
import { CreateContractDto } from './dto/create-contract.dto';
import { UpdateContractDto } from './dto/update-contract.dto';
import { AUDIT_ACTIONS } from '../common/constants/audit-actions';
import { AUDIT_TARGETS } from '../common/constants/audit-target.constant';
import { generateSecureToken, hashToken } from '../common/utils/token.util';
import { ClientStatus, ContractStatus } from '@prismamodels/client';

/**
 * Service handling business logic for clients, testimonials, and contracts.
 * Coordinates database interactions via Prisma and logs all domain events via AuditLogService.
 */
@Injectable()
export class ClientsService {

    private readonly logger = new Logger(ClientsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly auditLogService: AuditLogService,
        private readonly filesService: FilesService,
    ) {}

    // ==========================================
    // --- CLIENT CRUD OPERATIONS ---
    // ==========================================

    /**
     * Creates a new client in the database while ensuring email uniqueness.
     * Logs an audit event upon successful creation.
     * 
     * @param dto - Client creation payload.
     * @param actorId - ID of the user performing the action.
     * @param context - Additional contextual metadata for auditing (e.g., IP, user agent).
     */
    async create(dto: CreateClientDto, actorId: string, context?: AuditContext) {
        // Guard: archiving must only ever happen through archive() below, which also stamps
        // `archivedAt` - accepting `status: ARCHIVED` here would create a client that looks
        // archived to any status-based filter but has no `archivedAt` timestamp, so it would
        // never actually be picked up by CleanupService.cleanupArchivedClients() and would sit
        // in limbo forever.
        if (dto.status === ClientStatus.ARCHIVED) {
            throw new BadRequestException(
                'Cannot create a client with status ARCHIVED directly. Create it normally, then use DELETE /clients/:id to archive it.',
            );
        }

        // Check if a client with the same unique email already exists
        const existing = await this.prisma.client.findUnique({
            where: { email: dto.email },
        });

        if (existing) {
            throw new ConflictException('A client with this email already exists.');
        }

        // Persist new client record
        const client = await this.prisma.client.create({
            data: dto,
        });

        // Record system audit log for compliance and activity tracking
        await this.auditLogService.log({
            action: AUDIT_ACTIONS.CLIENT_CREATE,
            actorId,
            targetType: AUDIT_TARGETS.CLIENT,
            targetId: client.id,
            metadata: { email: client.email, status: client.status },
            context,
        });

        return client;
    }

    /**
     * Retrieves a paginated list of clients, optionally filtered by status.
     * Performs concurrent queries to fetch records and total count efficiently.
     *
     * Mirrors `PlatformsService.list()`: archived clients are excluded from the default view
     * unless `includeArchived` is explicitly set, the same way an archived platform doesn't
     * show up in the default platform list either.
     * 
     * @param page - Current page index (defaults to 1).
     * @param limit - Number of records per page (defaults to 20).
     * @param status - Optional status filter.
     * @param includeArchived - When false (default), excludes ARCHIVED clients regardless of
     *   `status`, unless `status` itself is explicitly `'ARCHIVED'`.
     */
    async findAll(page = 1, limit = 20, status?: string, includeArchived = false) {
        const skip = (page - 1) * limit;
        // QUALITY fix: validate the filter against the enum instead of forwarding any string to
        // Prisma (an unknown value used to surface as an opaque 500).
        if (status && !(Object.values(ClientStatus) as string[]).includes(status)) {
            throw new BadRequestException(`Invalid status "${status}".`);
        }
        const where = status
            ? { status: status as ClientStatus }
            : includeArchived
                ? {}
                : { status: { not: ClientStatus.ARCHIVED } };

        // Execute query and count simultaneously using Promise.all to optimize performance
        const [items, total] = await Promise.all([
            this.prisma.client.findMany({
                where,
                skip,
                take: limit,
                orderBy: { createdAt: 'desc' },
                include: {
                    platform: { select: { id: true, name: true, slug: true } },
                    _count: { select: { contracts: true } },
                },
            }),
            this.prisma.client.count({ where }),
        ]);

        return { 
            items, 
            total, 
            page, 
            limit, 
            totalPages: Math.ceil(total / limit) 
        };
    }

    /**
     * Fetches a single client record by unique ID, including platform and contracts relations.
     * Throws NotFoundException if the record does not exist.
     * 
     * @param id - Unique identifier of the client.
     */
    async findOne(id: string) {
        const client = await this.prisma.client.findUnique({
            where: { id },
            include: {
                platform: true,
                contracts: { orderBy: { createdAt: 'desc' } },
            },
        });

        if (!client) {
            throw new NotFoundException('Client not found.');
        }
        return client;
    }

    /**
     * Retrieves paginated clients assigned to a specific platform ID.
     * 
     * @param platformId - Unique identifier of the platform filter.
     * @param page - Current page index.
     * @param limit - Number of records per page.
     */
    async findByPlatform(platformId: string, page = 1, limit = 20, includeArchived = false) {
        const skip = (page - 1) * limit;
        const where = includeArchived
            ? { platformId }
            : { platformId, status: { not: ClientStatus.ARCHIVED } };

        const [items, total] = await Promise.all([
            this.prisma.client.findMany({
                where,
                skip,
                take: limit,
                orderBy: { createdAt: 'desc' },
                include: {
                    _count: { select: { contracts: true } },
                },
            }),
            this.prisma.client.count({ where }),
        ]);

        return {
            platformId,
            totalClients: total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            items,
        };
    }

    /**
     * Updates an existing client record.
     * Triggers an audit log entry if the client status is changed.
     * 
     * @param id - Unique client identifier.
     * @param dto - Partial payload with fields to update.
     * @param actorId - ID of the user performing the action.
     * @param context - Optional audit context.
     */
    async update(id: string, dto: UpdateClientDto, actorId: string, context?: AuditContext) {
        // Same reasoning as create() above - archiving must go through archive() so
        // `archivedAt` stays in sync with `status`.
        if (dto.status === ClientStatus.ARCHIVED) {
            throw new BadRequestException(
                'Cannot set status to ARCHIVED via update. Use DELETE /clients/:id to archive this client instead.',
            );
        }

        // Ensure client exists before updating
        const currentClient = await this.findOne(id);

        const updated = await this.prisma.client.update({
            where: { id },
            data: dto,
        });

        // Audit status transitions specifically for state change history
        if (dto.status && dto.status !== currentClient.status) {
            await this.auditLogService.log({
                action: AUDIT_ACTIONS.CLIENT_STATUS_CHANGED,
                actorId,
                targetType: AUDIT_TARGETS.CLIENT,
                targetId: id,
                metadata: { previousStatus: currentClient.status, newStatus: dto.status },
                context,
            });
        }

        return updated;
    }

    /**
     * Archives a client (soft delete): stops nothing (a client has no runtime, unlike a
     * platform), but starts the same kind of retention countdown - `CleanupService.
     * cleanupArchivedClients()` permanently deletes this client (and, cascading through it,
     * every one of its contracts and their attached files) once `archivedAt` is more than
     * `CLIENT_ARCHIVE_RETENTION_DAYS` (30 by default) in the past. Mirrors
     * `PlatformsService.archive()` exactly - see there for the full rationale.
     *
     * @param id - Client ID to archive.
     * @param actorId - ID of the user executing the archival.
     * @param context - Optional audit context.
     */
    async archive(id: string, actorId: string, context?: AuditContext) {
        const client = await this.findOne(id);

        if (client.status === ClientStatus.ARCHIVED) {
            throw new BadRequestException('This client is already archived.');
        }

        const archived = await this.prisma.client.update({
            where: { id },
            data: { status: ClientStatus.ARCHIVED, archivedAt: new Date() },
        });

        await this.auditLogService.log({
            action: AUDIT_ACTIONS.CLIENT_ARCHIVED,
            actorId,
            targetType: AUDIT_TARGETS.CLIENT,
            targetId: id,
            context,
        });

        return archived;
    }

    /**
     * Restores an archived client and cancels its pending deletion. Reverts `status` to
     * `ACTIVE` - like `PlatformsService.restore()` reverting to `DRAFT`, this is a single,
     * reasonable default rather than an attempt to remember whatever status the client held
     * before archiving (which was itself a real business-relationship state, e.g. `PROSPECT`
     * or `SUSPENDED`, not just a technical pipeline state - there is no one "correct" status to
     * restore into, so this makes the choice explicit rather than silently guessing).
     *
     * @param id - Client ID to restore.
     * @param actorId - ID of the user executing the restoration.
     * @param context - Optional audit context.
     */
    async restore(id: string, actorId: string, context?: AuditContext) {
        const client = await this.findOne(id);

        if (client.status !== ClientStatus.ARCHIVED) {
            throw new BadRequestException('This client is not archived.');
        }

        const restored = await this.prisma.client.update({
            where: { id },
            data: { status: ClientStatus.ACTIVE, archivedAt: null },
        });

        await this.auditLogService.log({
            action: AUDIT_ACTIONS.CLIENT_RESTORED,
            actorId,
            targetType: AUDIT_TARGETS.CLIENT,
            targetId: id,
            context,
        });

        return restored;
    }

    /**
     * Permanently and irreversibly deletes a client: every one of its contracts is purged
     * first (each contract's attached files are deleted from disk and the database, then the
     * contract row itself - see `purgeContractInternal()`), then the client row is deleted.
     * Contracts are purged explicitly rather than left to Prisma's `onDelete: Cascade` on
     * `ClientContract.client` precisely so their files get cleaned up correctly - a bare
     * cascade would only delete the `ClientContract` rows and `SetNull` their `FileAsset.
     * contractId`, leaving every attached document orphaned on disk forever.
     *
     * Requires the client to already be ARCHIVED - mirrors `PlatformsService.purge()`: nothing
     * gets permanently destroyed without first passing through the reversible archived state.
     *
     * @param id - Client ID to permanently delete.
     * @param actorId - ID of the user executing the purge.
     * @param context - Optional audit context.
     */
    async purge(id: string, actorId: string, context?: AuditContext) {
        const client = await this.findOne(id);

        if (client.status !== ClientStatus.ARCHIVED) {
            throw new BadRequestException(
                'Only an archived client can be permanently deleted. Archive it first with DELETE /clients/:id.',
            );
        }

        await this.purgeClientInternal(id);

        await this.auditLogService.log({
            action: AUDIT_ACTIONS.CLIENT_PURGED,
            actorId,
            targetType: AUDIT_TARGETS.CLIENT,
            targetId: id,
            context,
        });

        return { message: 'Client permanently deleted.' };
    }

    /**
     * Called daily by `CleanupService`. Permanently deletes every client continuously ARCHIVED
     * for longer than `retentionDays` - see `purge()` for exactly what that removes. Each
     * client is purged independently inside its own try/catch so one failure never blocks the
     * rest of the batch, mirroring `PlatformsService.purgeExpiredArchives()`.
     *
     * @returns The count of clients permanently deleted.
     */
    async purgeExpiredArchives(retentionDays: number): Promise<number> {
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

        const expired = await this.prisma.client.findMany({
            where: { status: ClientStatus.ARCHIVED, archivedAt: { not: null, lt: cutoff } },
            select: { id: true },
        });

        let purgedCount = 0;
        for (const client of expired) {
            try {
                await this.purgeClientInternal(client.id);
                purgedCount++;
            } catch (error) {
                this.logger.error(
                    `Failed to auto-purge archived client ${client.id} after retention window expired.`,
                    error instanceof Error ? error.stack : String(error),
                );
            }
        }

        return purgedCount;
    }

    /**
     * Shared implementation behind `purge()` (manual) and `purgeExpiredArchives()`
     * (automatic): purge every contract belonging to this client (files + row), then delete
     * the client row itself. `Client.testimonialToken`/`Client.email` uniqueness constraints
     * mean the row must actually be gone (not just archived) for that email/token to ever be
     * reusable again - Prisma's cascade handles anything else still pointing at this client
     * (e.g. `Project.clientId` is `onDelete: SetNull`, so any project that referenced this
     * client is decoupled rather than deleted, preserving its own history).
     */
    private async purgeClientInternal(clientId: string): Promise<void> {
        const contracts = await this.prisma.clientContract.findMany({
            where: { clientId },
            select: { id: true },
        });

        for (const contract of contracts) {
            await this.purgeContractInternal(contract.id);
        }

        await this.prisma.client.delete({ where: { id: clientId } });
    }

    // ==========================================
    // --- CLIENT CONTRACT LIFECYCLE (archive/restore/purge) ---
    // ==========================================

    /**
     * Retrieves a single contract by ID.
     */
    async getContract(id: string) {
        const contract = await this.prisma.clientContract.findUnique({
            where: { id },
            include: { files: true },
        });
        if (!contract) throw new NotFoundException('Contract not found.');
        return contract;
    }

    /**
     * Updates a contract's editable fields. Rejects `status: ARCHIVED` for the same reason as
     * `update()` above - archiving must go through `archiveContract()` so `archivedAt` stays in
     * sync with `status`.
     */
    async updateContract(id: string, dto: UpdateContractDto, actorId: string, context?: AuditContext) {
        if (dto.status === ContractStatus.ARCHIVED) {
            throw new BadRequestException(
                'Cannot set status to ARCHIVED via update. Use DELETE /contracts/:id to archive this contract instead.',
            );
        }

        await this.findContractOrThrow(id);

        const updated = await this.prisma.clientContract.update({
            where: { id },
            data: {
                ...dto,
                signedAt: dto.signedAt ? new Date(dto.signedAt) : undefined,
                startedAt: dto.startedAt ? new Date(dto.startedAt) : undefined,
                expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
            },
        });

        await this.auditLogService.log({
            action: AUDIT_ACTIONS.CONTRACT_UPDATE,
            actorId,
            targetType: AUDIT_TARGETS.CLIENT_CONTRACT,
            targetId: id,
            context,
        });

        return updated;
    }

    /**
     * Archives a contract (soft delete) - independently of its client's own archive state, a
     * single contract can be archived/restored/purged on its own. Same mechanism as
     * `archive()` above, just scoped to `ClientContract` instead of `Client`.
     */
    async archiveContract(id: string, actorId: string, context?: AuditContext) {
        const contract = await this.findContractOrThrow(id);

        if (contract.status === ContractStatus.ARCHIVED) {
            throw new BadRequestException('This contract is already archived.');
        }

        const archived = await this.prisma.clientContract.update({
            where: { id },
            data: { status: ContractStatus.ARCHIVED, archivedAt: new Date() },
        });

        await this.auditLogService.log({
            action: AUDIT_ACTIONS.CONTRACT_ARCHIVED,
            actorId,
            targetType: AUDIT_TARGETS.CLIENT_CONTRACT,
            targetId: id,
            metadata: { clientId: contract.clientId },
            context,
        });

        return archived;
    }

    /**
     * Restores an archived contract, reverting `status` to `ACTIVE` (same single-reasonable-
     * default reasoning as `restore()` above) and cancelling its pending deletion.
     */
    async restoreContract(id: string, actorId: string, context?: AuditContext) {
        const contract = await this.findContractOrThrow(id);

        if (contract.status !== ContractStatus.ARCHIVED) {
            throw new BadRequestException('This contract is not archived.');
        }

        const restored = await this.prisma.clientContract.update({
            where: { id },
            data: { status: ContractStatus.ACTIVE, archivedAt: null },
        });

        await this.auditLogService.log({
            action: AUDIT_ACTIONS.CONTRACT_RESTORED,
            actorId,
            targetType: AUDIT_TARGETS.CLIENT_CONTRACT,
            targetId: id,
            metadata: { clientId: contract.clientId },
            context,
        });

        return restored;
    }

    /**
     * Permanently deletes an already-archived contract: its attached files (disk + database)
     * are removed first, then the contract row. Requires the contract to already be ARCHIVED -
     * same reversible-state-first guarantee as everywhere else in this lifecycle.
     */
    async purgeContract(id: string, actorId: string, context?: AuditContext) {
        const contract = await this.findContractOrThrow(id);

        if (contract.status !== ContractStatus.ARCHIVED) {
            throw new BadRequestException(
                'Only an archived contract can be permanently deleted. Archive it first with DELETE /contracts/:id.',
            );
        }

        await this.purgeContractInternal(id);

        await this.auditLogService.log({
            action: AUDIT_ACTIONS.CONTRACT_PURGED,
            actorId,
            targetType: AUDIT_TARGETS.CLIENT_CONTRACT,
            targetId: id,
            metadata: { clientId: contract.clientId },
            context,
        });

        return { message: 'Contract permanently deleted.' };
    }

    /**
     * Called daily by `CleanupService`. Permanently deletes every contract continuously
     * ARCHIVED for longer than `retentionDays`, independently of its client's own archive
     * state (a contract can be archived on its own without its client being archived at all).
     *
     * @returns The count of contracts permanently deleted.
     */
    async purgeExpiredContractArchives(retentionDays: number): Promise<number> {
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

        const expired = await this.prisma.clientContract.findMany({
            where: { status: ContractStatus.ARCHIVED, archivedAt: { not: null, lt: cutoff } },
            select: { id: true },
        });

        let purgedCount = 0;
        for (const contract of expired) {
            try {
                await this.purgeContractInternal(contract.id);
                purgedCount++;
            } catch (error) {
                this.logger.error(
                    `Failed to auto-purge archived contract ${contract.id} after retention window expired.`,
                    error instanceof Error ? error.stack : String(error),
                );
            }
        }

        return purgedCount;
    }

    /**
     * Shared implementation behind every contract purge path (manual, automatic, and via
     * `purgeClientInternal()` when the whole client is purged): delete every `FileAsset`
     * attached to this contract (disk + database, via `FilesService`), then the contract row
     * itself. File cleanup is best-effort/non-blocking - a file that can't be removed must not
     * make the overall purge fail, for the same reason `PlatformsService.purgePlatform()`
     * treats its own file cleanup as best-effort.
     */
    private async purgeContractInternal(contractId: string): Promise<void> {
        try {
            await this.filesService.purgeFilesForParent({ contractId });
        } catch (error) {
            this.logger.warn(
                `Could not fully remove attached files for contract ${contractId} during purge.`,
                error instanceof Error ? error.stack : String(error),
            );
        }

        await this.prisma.clientContract.delete({ where: { id: contractId } });
    }

    /**
     * Helper retrieving a contract entity or throwing a 404 exception.
     */
    private async findContractOrThrow(id: string) {
        const contract = await this.prisma.clientContract.findUnique({ where: { id } });
        if (!contract) throw new NotFoundException('Contract not found.');
        return contract;
    }

    // ==========================================
    // --- REVIEWS & TESTIMONIALS (TOKEN-BASED) ---
    // ==========================================

    /**
     * Generates a cryptographically secure, time-limited token allowing a client 
     * to submit a review without requiring authentication.
     * 
     * @param id - Target client ID.
     * @param actorId - ID of the user issuing the invitation.
     * @param context - Optional audit context.
     */
    async generateTestimonialInvite(id: string, actorId: string, context?: AuditContext) {
        const client = await this.findOne(id);

        // An archived client is meant to be winding down toward permanent deletion (see
        // archive() above) - issuing a fresh invite link for one would keep soliciting activity
        // from a relationship that's supposed to be closed out, and the resulting testimonial
        // would itself be purged along with the client at the end of its retention window
        // anyway.
        if (client.status === ClientStatus.ARCHIVED) {
            throw new BadRequestException(
                'Cannot generate a testimonial invite for an archived client. Restore it first.',
            );
        }

        // Generate a 64-character random hex token (256 bits of entropy) using the project's
        // shared, audited token-generation helper - the same one used for invitation and
        // refresh tokens - rather than calling `crypto.randomBytes` directly in this file.
        const token = generateSecureToken(32);
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7); // Token remains valid for 7 days

        // SECURITY FIX: every other bearer token in this codebase (invitation tokens, refresh
        // tokens) is stored as a SHA-256 hash rather than in plain text, so that a database
        // leak/backup exposure alone is not enough to impersonate a client submitting a
        // testimonial. `testimonialToken` was previously the only exception to that rule -
        // we now hash it the same way before persisting it.
        await this.prisma.client.update({
            where: { id },
            data: {
                testimonialToken: hashToken(token),
                testimonialTokenExpiresAt: expiresAt,
            },
        });

        // await this.auditLogService.log({
        //     action: AUDIT_ACTIONS.CLIENT_TESTIMONIAL_INVITE_SENT,
        //     actorId,
        //     targetType: AUDIT_TARGETS.CLIENT,
        //     targetId: id,
        //     metadata: { expiresAt },
        //     context,
        // });

        return {
            testimonialToken: token,
            expiresAt,
        };
    }

    /**
     * Submits a testimonial using an unexpired single-use validation token.
     * Consumes the token upon completion and places the review in moderation status.
     * 
     * @param token - Secure access token.
     * @param dto - Feedback content and numeric rating payload.
     */
    async submitTestimonialByToken(token: string, dto: SubmitTestimonialDto) {
        if (!token) {
            throw new BadRequestException('Validation token is required.');
        }

        // Verify token validity and expiration threshold. We look up by the HASH of the
        // provided token (never the raw value) - consistent with how invitation and refresh
        // tokens are validated elsewhere in the codebase.
        const client = await this.prisma.client.findFirst({
            where: {
                testimonialToken: hashToken(token),
                testimonialTokenExpiresAt: { gte: new Date() },
            },
        });

        if (!client) {
            throw new NotFoundException('Invalid or expired invitation link.');
        }

        // Same reasoning as generateTestimonialInvite() above - an archived client's invite
        // link must stop working the moment it's archived, not linger usable until its
        // (independent) 7-day token expiry. Reported identically to an invalid/expired token
        // rather than a distinct error, so this never leaks whether a given link's client has
        // been archived to whoever is holding it.
        if (client.status === ClientStatus.ARCHIVED) {
            throw new NotFoundException('Invalid or expired invitation link.');
        }

        const updated = await this.prisma.client.update({
            where: { id: client.id },
            data: {
                testimonialText: dto.testimonialText,
                testimonialRating: dto.testimonialRating,
                testimonialGivenAt: new Date(),
                isTestimonialPublic: false,
                testimonialToken: null,
                testimonialTokenExpiresAt: null,
            },
        });

        await this.auditLogService.log({
            action: AUDIT_ACTIONS.CLIENT_TESTIMONIAL_SUBMITTED,
            targetType: AUDIT_TARGETS.CLIENT,
            targetId: client.id,
            metadata: { rating: dto.testimonialRating },
        });

        return { message: 'Your review has been successfully submitted.' };
    }

    /**
     * Toggles whether a client's testimonial is visible on public listings.
     * 
     * @param id - Unique client identifier.
     * @param isPublic - Target visibility flag.
     * @param actorId - Admin user making the update.
     * @param context - Optional audit context.
     */
    async toggleTestimonialVisibility(id: string, isPublic: boolean, actorId: string, context?: AuditContext) {
        await this.findOne(id);

        const updated = await this.prisma.client.update({
            where: { id },
            data: { isTestimonialPublic: isPublic },
        });

        await this.auditLogService.log({
            action: AUDIT_ACTIONS.CLIENT_TESTIMONIAL_TOGGLED,
            actorId,
            targetType: AUDIT_TARGETS.CLIENT,
            targetId: id,
            metadata: { isTestimonialPublic: isPublic },
            context,
        });

        return updated;
    }

    /**
     * Public read method: returns approved testimonials containing actual text content.
     * Excludes sensitive client fields, and excludes archived clients - an archived client is
     * winding down toward permanent deletion (see archive() above), so its testimonial (and
     * name) stop appearing on the public page the moment it's archived, the same way it
     * disappears from every other default client list.
     */
    async getPublicTestimonials() {
        return this.prisma.client.findMany({
            where: {
                isTestimonialPublic: true,
                testimonialText: { not: null },
                status: { not: ClientStatus.ARCHIVED },
            },
            select: {
                id: true,
                firstName: true,
                lastName: true,
                companyName: true,
                testimonialText: true,
                testimonialRating: true,
                testimonialGivenAt: true,
            },
            orderBy: { testimonialGivenAt: 'desc' },
        });
    }

    // ==========================================
    // --- CLIENT CONTRACT MANAGEMENT ---
    // ==========================================

    /**
     * Attaches a new contractual record to a specific client profile.
     * 
     * @param clientId - Target client ID.
     * @param dto - Contract specifications payload.
     * @param actorId - ID of user creating the contract.
     * @param context - Optional audit context.
     */
    async addContract(clientId: string, dto: CreateContractDto, actorId: string, context?: AuditContext) {
        // Guard: same reasoning as create()/update() above - a contract created directly with
        // status ARCHIVED would have no archivedAt timestamp, so it would never be picked up
        // by CleanupService.cleanupArchivedContracts() and would sit in limbo forever.
        if (dto.status === ContractStatus.ARCHIVED) {
            throw new BadRequestException(
                'Cannot create a contract with status ARCHIVED directly. Create it normally, then use DELETE /contracts/:id to archive it.',
            );
        }

        // Validate target client existence
        await this.findOne(clientId);

        const contract = await this.prisma.clientContract.create({
            data: {
                clientId,
                ...dto,
            },
        });

        await this.auditLogService.log({
            action: AUDIT_ACTIONS.CONTRACT_CREATE,
            actorId,
            targetType: AUDIT_TARGETS.CLIENT_CONTRACT,
            targetId: contract.id,
            metadata: { 
                clientId, 
                contractNumber: contract.contractNumber, 
                amount: contract.billingAmount 
            },
            context,
        });

        return contract;
    }
}