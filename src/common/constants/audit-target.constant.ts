/**
 * Object map defining all valid target entity types for audit logging.
 * Used to categorize and query actions performed on specific system resources.
 */
export const AUDIT_TARGETS = {
    /**
     * Target type for actions affecting User accounts or profiles.
     */
    USER: 'User',

    /**
     * Target type for actions affecting Platform entities.
     */
    PLATFORM: 'Platform',

    /**
     * Target type for actions affecting RBAC Roles.
     */
    ROLE: 'Role',

    /**
     * Target type for actions affecting system Permissions.
     */
    PERMISSION: 'Permission',

    /**
     * Target type for actions affecting generic business Entities.
     */
    ENTITY: 'Entity',

    /**
     * Target type for actions affecting granular entity Fields.
     */
    FIELD: 'Field',

    /**
     * Target type for actions affecting Client records or testimonials.
     */
    CLIENT: 'Client',

    /**
     * Target type for actions affecting Client Contracts or billing agreements.
     */
    CLIENT_CONTRACT: 'ClientContract',

    /**
     * Target type for actions affecting onboarding or system Invitations.
     */
    INVITATION: 'Invitation',

    /**
     * Target type for actions affecting Generation jobs or assets.
     */
    GENERATION: 'Generation',

    BACKUP: 'Backup',
} as const;

/**
 * Union type representing all allowable string values for audit target types.
 * Derived automatically from the `AUDIT_TARGETS` constant map.
 */
export type AuditTarget = (typeof AUDIT_TARGETS)[keyof typeof AUDIT_TARGETS];
