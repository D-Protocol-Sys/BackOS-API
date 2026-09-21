import { 
    PERMISSIONS, 
    PERMISSION_DESCRIPTIONS, 
    PermissionKey 
} from './permissions.constant';

/**
 * -----------------------------------------------------------------------------
 * 1. Specific System & Security Audit Actions
 * -----------------------------------------------------------------------------
 * Audit logs that are distinct from standard user RBAC permissions 
 * (e.g. Authentication flow, MFA events, and detailed execution states).
 */
export const SYSTEM_AUDIT_ACTIONS = {
    // Authentication & Session
    LOGIN: 'auth.login',
    LOGIN_FAILED: 'auth.login.failed',
    LOGIN_LOCKED: 'auth.login.locked',
    LOGOUT: 'auth.logout',
    MFA_ENABLED: 'auth.mfa.enabled',
    MFA_DISABLED: 'auth.mfa.disabled',
    REFRESH_TOKEN_CREATED: 'auth.refresh-token.created',
    REFRESH_TOKEN_REVOKED: 'auth.refresh-token.revoked',
    // SECURITY FIX (audit #3): step-up re-authentication failure, e.g. a wrong TOTP code
    // supplied when confirming a destructive self-service action such as `DELETE /users/me`.
    STEP_UP_FAILED: 'auth.step-up.failed',

    // User
    USERS_REACTIVATE: 'users.reactivate',
    USERS_DISABLE: 'users.disable',
    USERS_ANONYMIZE: 'users.anonymize',

    // Client Lifecycle Events
    CLIENT_STATUS_CHANGED: 'client.status_changed',
    CLIENT_TESTIMONIAL_SUBMITTED: 'client.testimonial.submitted',
    CLIENT_TESTIMONIAL_TOGGLED: 'client.testimonial.toggled',
    // Archive/restore/purge lifecycle (mirrors PlatformsService.archive()/restore()/purge() -
    // see CleanupService.cleanupArchivedClients()): archiving stops nothing (a client has no
    // runtime), but starts the same kind of retention countdown a platform gets.
    CLIENT_ARCHIVED: 'client.archived',
    CLIENT_RESTORED: 'client.restored',
    CLIENT_PURGED: 'client.purged',

    // Contract Events
    CONTRACT_SIGNED: 'contract.signed',
    CONTRACT_EXPIRED: 'contract.expired',
    CONTRACT_TERMINATED: 'contract.terminated',
    CONTRACT_ARCHIVED: 'contract.archived',
    CONTRACT_RESTORED: 'contract.restored',
    CONTRACT_PURGED: 'contract.purged',

    // INVITATION
    INVITATION_CREATED: 'invitation.created',
    INVITATION_SENT: 'invitation.sent',
    INVITATION_FAILED: 'invitation.failed',
    INVITATION_USED: 'invitation.used',
    INVITATION_EXPIRED: 'invitation.expired',
    INVITATION_LOCKED: 'invitation.locked',

    // RECOVERY CODE
    RECOVERY_CODE_USED: 'recoveryCode.used',

    // System Events / Granular Operations
    GENERATION_STARTED: 'generation.started',
    GENERATION_COMPLETED: 'generation.completed',
    GENERATION_FAILED: 'generation.failed',
} as const;

export type SystemAuditAction = (typeof SYSTEM_AUDIT_ACTIONS)[keyof typeof SYSTEM_AUDIT_ACTIONS];

/**
 * -----------------------------------------------------------------------------
 * 2. Descriptions for System Audit Actions
 * -----------------------------------------------------------------------------
 * Human-readable mapping for non-permission audit events.
 */
export const SYSTEM_AUDIT_DESCRIPTIONS: Record<SystemAuditAction, string> = {
    [SYSTEM_AUDIT_ACTIONS.LOGIN]: 'User successfully authenticated into the system',
    [SYSTEM_AUDIT_ACTIONS.LOGIN_FAILED]: 'A login attempt failed (invalid credentials or TOTP code)',
    [SYSTEM_AUDIT_ACTIONS.LOGIN_LOCKED]: 'Account temporarily locked after too many failed login attempts',
    [SYSTEM_AUDIT_ACTIONS.LOGOUT]: 'User logged out or session expired',
    [SYSTEM_AUDIT_ACTIONS.MFA_ENABLED]: 'Multi-Factor Authentication was enabled for an account',
    [SYSTEM_AUDIT_ACTIONS.MFA_DISABLED]: 'Multi-Factor Authentication was disabled for an account',
    [SYSTEM_AUDIT_ACTIONS.REFRESH_TOKEN_CREATED]: 'A new refresh token was issued',
    [SYSTEM_AUDIT_ACTIONS.REFRESH_TOKEN_REVOKED]: 'A refresh token was explicitly revoked',
    [SYSTEM_AUDIT_ACTIONS.STEP_UP_FAILED]: 'A step-up re-authentication attempt for a destructive action failed',

    [SYSTEM_AUDIT_ACTIONS.USERS_REACTIVATE]: 'Reactivate a user',
    [SYSTEM_AUDIT_ACTIONS.USERS_DISABLE]: 'Disable a user',
    [SYSTEM_AUDIT_ACTIONS.USERS_ANONYMIZE]: 'Anonymize a user',

    [SYSTEM_AUDIT_ACTIONS.CLIENT_STATUS_CHANGED]: 'Client lifecycle status was changed (e.g. Prospect to Active)',
    [SYSTEM_AUDIT_ACTIONS.CLIENT_TESTIMONIAL_SUBMITTED]: 'Client submitted a review or testimonial',
    [SYSTEM_AUDIT_ACTIONS.CLIENT_TESTIMONIAL_TOGGLED]: 'Client testimonial public visibility was changed',
    [SYSTEM_AUDIT_ACTIONS.CLIENT_ARCHIVED]: 'Client was archived - permanently deleted after the retention window unless restored',
    [SYSTEM_AUDIT_ACTIONS.CLIENT_RESTORED]: 'Archived client was restored, cancelling its pending deletion',
    [SYSTEM_AUDIT_ACTIONS.CLIENT_PURGED]: 'Archived client was permanently deleted, along with its contracts and their files',
    [SYSTEM_AUDIT_ACTIONS.CONTRACT_SIGNED]: 'Contract was officially marked as signed',
    [SYSTEM_AUDIT_ACTIONS.CONTRACT_EXPIRED]: 'Contract reached its expiration date',
    [SYSTEM_AUDIT_ACTIONS.CONTRACT_TERMINATED]: 'Contract was terminated prior to expiration',
    [SYSTEM_AUDIT_ACTIONS.CONTRACT_ARCHIVED]: 'Contract was archived - permanently deleted after the retention window unless restored',
    [SYSTEM_AUDIT_ACTIONS.CONTRACT_RESTORED]: 'Archived contract was restored, cancelling its pending deletion',
    [SYSTEM_AUDIT_ACTIONS.CONTRACT_PURGED]: 'Archived contract was permanently deleted, along with its files',

    [SYSTEM_AUDIT_ACTIONS.INVITATION_CREATED]: 'A new user invitation was created',
    [SYSTEM_AUDIT_ACTIONS.INVITATION_SENT]: 'An invitation email was sent to a user',
    [SYSTEM_AUDIT_ACTIONS.INVITATION_FAILED]: 'Invitation email delivery failed',
    [SYSTEM_AUDIT_ACTIONS.INVITATION_EXPIRED]: 'A user invitation expired',
    [SYSTEM_AUDIT_ACTIONS.INVITATION_USED]: 'A user used an invitation',
    [SYSTEM_AUDIT_ACTIONS.INVITATION_LOCKED]: 'Invitation has been invalidated',

    [SYSTEM_AUDIT_ACTIONS.RECOVERY_CODE_USED]: 'A user used a recovery code',

    [SYSTEM_AUDIT_ACTIONS.GENERATION_STARTED]: 'Code generation process initiated',
    [SYSTEM_AUDIT_ACTIONS.GENERATION_COMPLETED]: 'Code generation completed successfully',
    [SYSTEM_AUDIT_ACTIONS.GENERATION_FAILED]: 'Code generation process failed',
};

/**
 * -----------------------------------------------------------------------------
 * 3. Unified Audit Actions Catalog (DRY Principle)
 * -----------------------------------------------------------------------------
 * Merges standard RBAC permissions with custom system audit actions.
 * Any new entry added to `permission.ts` will automatically propagate here.
 */
export const AUDIT_ACTIONS = {
    ...PERMISSIONS,
    ...SYSTEM_AUDIT_ACTIONS,
} as const;

/**
 * Type union representing all valid audit action keys across the application.
 */
export type AuditAction = PermissionKey | SystemAuditAction;

/**
 * -----------------------------------------------------------------------------
 * 4. Unified Audit Descriptions Mapping
 * -----------------------------------------------------------------------------
 * Combines permission descriptions with system audit descriptions to ensure 
 * 100% type safety and zero redundancy.
 */
export const AUDIT_ACTION_DESCRIPTIONS: Record<AuditAction, string> = {
    ...PERMISSION_DESCRIPTIONS,
    ...SYSTEM_AUDIT_DESCRIPTIONS,
};