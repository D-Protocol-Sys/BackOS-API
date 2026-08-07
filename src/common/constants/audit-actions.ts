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
    LOGOUT: 'auth.logout',
    MFA_ENABLED: 'auth.mfa.enabled',
    MFA_DISABLED: 'auth.mfa.disabled',
    REFRESH_TOKEN_CREATED: 'auth.refresh-token.created',
    REFRESH_TOKEN_REVOKED: 'auth.refresh-token.revoked',

    // User
    USERS_REACTIVATE: 'users.reactivate',
    USERS_DISABLE: 'users.disable',
    USERS_ANONYMIZE: 'users.anonymize',

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
    [SYSTEM_AUDIT_ACTIONS.LOGOUT]: 'User logged out or session expired',
    [SYSTEM_AUDIT_ACTIONS.MFA_ENABLED]: 'Multi-Factor Authentication was enabled for an account',
    [SYSTEM_AUDIT_ACTIONS.MFA_DISABLED]: 'Multi-Factor Authentication was disabled for an account',
    [SYSTEM_AUDIT_ACTIONS.REFRESH_TOKEN_CREATED]: 'A new refresh token was issued',
    [SYSTEM_AUDIT_ACTIONS.REFRESH_TOKEN_REVOKED]: 'A refresh token was explicitly revoked',

    [SYSTEM_AUDIT_ACTIONS.USERS_REACTIVATE]: 'Reactivate a user',
    [SYSTEM_AUDIT_ACTIONS.USERS_DISABLE]: 'Disable a user',
    [SYSTEM_AUDIT_ACTIONS.USERS_ANONYMIZE]: 'Anonymize a user',

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