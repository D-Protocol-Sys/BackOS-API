import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService, AuditContext } from '../audit/audit-log.service';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';
import { SubmitTestimonialDto } from './dto/submit-testimonial.dto';
import { CreateContractDto } from './dto/create-contract.dto';
import { AUDIT_ACTIONS } from '../common/constants/audit-actions';
import { AUDIT_TARGETS } from '../common/constants/audit-target.constant';
import { generateSecureToken, hashToken } from '../common/utils/token.util';

/**
 * Service handling business logic for clients, testimonials, and contracts.
 * Coordinates database interactions via Prisma and logs all domain events via AuditLogService.
 */
@Injectable()
export class ClientsService {

    constructor(
        private readonly prisma: PrismaService,
        private readonly auditLogService: AuditLogService,
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
     * @param page - Current page index (defaults to 1).
     * @param limit - Number of records per page (defaults to 20).
     * @param status - Optional status filter.
     */
    async findAll(page = 1, limit = 20, status?: string) {
        const skip = (page - 1) * limit;
        const where = status ? { status: status as any } : {};

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
    async findByPlatform(platformId: string, page = 1, limit = 20) {
        const skip = (page - 1) * limit;

        const [items, total] = await Promise.all([
            this.prisma.client.findMany({
                where: { platformId },
                skip,
                take: limit,
                orderBy: { createdAt: 'desc' },
                include: {
                    _count: { select: { contracts: true } },
                },
            }),
            this.prisma.client.count({ where: { platformId } }),
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
     * Deletes a client record from the database.
     * 
     * @param id - Client ID to delete.
     * @param actorId - ID of the user executing deletion.
     * @param context - Optional audit context.
     */
    async delete(id: string, actorId: string, context?: AuditContext) {
        // Confirm existence prior to deletion
        await this.findOne(id);

        await this.prisma.client.delete({ where: { id } });

        await this.auditLogService.log({
            action: AUDIT_ACTIONS.CLIENT_DELETE,
            actorId,
            targetType: AUDIT_TARGETS.CLIENT,
            targetId: id,
            context,
        });

        return { success: true };
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
        await this.findOne(id);

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
     * Excludes sensitive client fields.
     */
    async getPublicTestimonials() {
        return this.prisma.client.findMany({
            where: {
                isTestimonialPublic: true,
                testimonialText: { not: null },
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