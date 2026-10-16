import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prismamodels/client';
import { AuditAction } from '../common/constants/audit-actions';
import type { FeatureAuditAction, FeatureAuditTarget } from '../features/feature.types';
import { AuditTarget } from '../common/constants/audit-target.constant';
import { currentRequestId } from '../common/request-context/request-context';

/**
 * Interface representing HTTP and network metadata associated with a request.
 * Captures client context essential for security auditing, compliance, and incident investigation.
 */
export interface AuditContext {
    /**
     * The IP address of the client originating the request.
     */
    ipAddress?: string;

    /**
     * The raw User-Agent string sent by the client application or browser.
     */
    userAgent?: string;
}

/**
 * Payload interface required to construct and persist a standard Audit Log entry.
 */
export interface AuditLogEntry {
    /**
     * The specific action or event being audited (e.g., USER_LOGIN, ROLE_UPDATED).
     */
    action: AuditAction | FeatureAuditAction;

    /**
     * Unique identifier of the user performing the action (null if system-generated or unauthenticated).
     */
    actorId?: string | null;

    /**
     * The broad entity/domain category affected by the action (e.g., User, Platform).
     */
    targetType?: AuditTarget | FeatureAuditTarget;

    /**
     * Unique identifier of the specific target entity affected.
     */
    targetId?: string;

    /**
     * Additional structured JSON metadata (e.g., changed fields, diff payload, error details).
     */
    metadata?: Prisma.InputJsonValue;

    /**
     * Technical request context including IP address and user-agent string.
     */
    context?: AuditContext;

    /**
     * Correlation ID used to trace the entire request lifecycle across services.
     */
    requestId?: string;
}

/**
 * Audit Log Service
 * * Central service responsible for recording critical security events, system mutations,
 * and administrative actions into an immutable audit trail for accountability and compliance.
 */
@Injectable()
export class AuditLogService {
    constructor(private readonly prisma: PrismaService) {}

    /**
     * Persists a structured audit log record into the database.
     * * @param entry - The complete audit event payload containing action, actor, target, and contextual metadata.
     * @returns Promise resolving once the audit entry is successfully stored.
     */
    async log(entry: AuditLogEntry): Promise<void> {
        await this.prisma.auditLog.create({
            data: {
                action: entry.action,
                actorId: entry.actorId,
                targetType: entry.targetType,
                targetId: entry.targetId,
                metadata: entry.metadata ?? {},
                ipAddress: entry.context?.ipAddress,
                userAgent: entry.context?.userAgent,
                // SEC-027: correlated with the HTTP request that caused it.
                requestId: entry.requestId ?? currentRequestId(),
            },
        });
    }

    /**
     * Fetches the most recent audit log entries for administrative oversight and compliance dashboards.
     * * @param limit - Maximum number of audit records to retrieve (defaults to 100).
     * @returns Array of audit log records ordered from newest to oldest, including basic actor user profile attributes.
     */
    async list(limit = 100) {
        return this.prisma.auditLog.findMany({
            orderBy: { createdAt: 'desc' },
            take: limit,
            include: {
                actor: {
                    select: {
                        id: true,
                        workEmail: true,
                        firstName: true,
                        lastName: true,
                    },
                },
            },
        });
    }
}
