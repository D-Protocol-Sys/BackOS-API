export const PERMISSIONS = {

    // Users
    USERS_READ: 'users.read',
    USERS_UPDATE: 'users.update',
    USERS_CREATE: 'users.create',
    USERS_DEACTIVATE: 'users.deactivate',
    USERS_DELETE: 'users.delete',
    USERS_EXPORT: 'users.export',
    USERS_MANAGE_ROLES: 'users.manage-roles',

    // Roles & permissions (RBAC)
    ROLES_CREATE: 'roles.create',
    ROLES_READ: 'roles.read',
    ROLES_UPDATE: 'roles.update',
    ROLES_DELETE: 'roles.delete',
    PERMISSIONS_READ: 'permissions.read',

    // Platforms
    PLATFORM_CREATE: 'platform.create',
    PLATFORM_READ: 'platform.read',
    PLATFORM_UPDATE: 'platform.update',
    PLATFORM_DELETE: 'platform.delete',
    PLATFORM_MANAGE_MEMBERS: 'platform.manage-members',
    PLATFORM_TRANSFER_OWNERSHIP: 'platform.transfer-ownership',

    // Entities
    ENTITY_CREATE: 'entity.create',
    ENTITY_READ: 'entity.read',
    ENTITY_UPDATE: 'entity.update',
    ENTITY_DELETE: 'entity.delete',

    // Fields
    FIELD_CREATE: 'field.create',
    FIELD_READ: 'field.read',
    FIELD_UPDATE: 'field.update',
    FIELD_DELETE: 'field.delete',

    // Files & Planning
    FILE_MANAGE: 'file.manage',
    PLANNING_READ: 'planning.read',
    PLANNING_MANAGE: 'planning.manage',

    // Clients & Contracts
    CLIENT_CREATE: 'client.create',
    CLIENT_READ: 'client.read',
    CLIENT_UPDATE: 'client.update',
    CLIENT_DELETE: 'client.delete',
    CLIENT_MANAGE_TESTIMONIALS: 'client.manage-testimonials',
    CONTRACT_CREATE: 'contract.create',
    CONTRACT_READ: 'contract.read',
    CONTRACT_UPDATE: 'contract.update',
    CONTRACT_DELETE: 'contract.delete',

    // Projects
    PROJECT_CREATE: 'project.create',
    PROJECT_READ: 'project.read',
    PROJECT_UPDATE: 'project.update',
    PROJECT_DELETE: 'project.delete',

    // Generator
    GENERATOR_EXECUTE: 'generator.execute',
    GENERATION_READ: 'generation.read',

    // Runtime
    RUNTIME_MANAGE: 'runtime.manage',

    // Audit
    AUDIT_READ: 'audit.read',

    // Backups
    BACKUP_MANAGE: 'backup.manage',

} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const PERMISSION_DESCRIPTIONS: Record<PermissionKey, string> = {

    [PERMISSIONS.USERS_READ]: "View any user's profile and account details",
    [PERMISSIONS.USERS_UPDATE]: "Update any user's profile information (first name, last name)",
    [PERMISSIONS.USERS_CREATE]: 'Create a new user account by invitation (bypasses self-registration)',
    [PERMISSIONS.USERS_DEACTIVATE]: 'Deactivate or reactivate a user account',
    [PERMISSIONS.USERS_DELETE]: 'Permanently delete a user account',
    [PERMISSIONS.USERS_EXPORT]: "Export any user's personal data",
    [PERMISSIONS.USERS_MANAGE_ROLES]: 'Assign or remove roles from a user',

    [PERMISSIONS.ROLES_CREATE]: 'Create a new role',
    [PERMISSIONS.ROLES_READ]: 'View roles and their assigned permissions',
    [PERMISSIONS.ROLES_UPDATE]: "Update a role's name, description, or permissions",
    [PERMISSIONS.ROLES_DELETE]: 'Delete a role',
    [PERMISSIONS.PERMISSIONS_READ]: 'View the catalog of available permissions',

    [PERMISSIONS.PLATFORM_CREATE]: 'Create a new platform',
    [PERMISSIONS.PLATFORM_READ]: 'View platform details',
    [PERMISSIONS.PLATFORM_UPDATE]: "Update a platform's configuration",
    [PERMISSIONS.PLATFORM_DELETE]: 'Delete a platform',
    [PERMISSIONS.PLATFORM_MANAGE_MEMBERS]: 'Add, update, or remove members on any platform',
    [PERMISSIONS.PLATFORM_TRANSFER_OWNERSHIP]: 'Transfer ownership of a platform to another user',

    [PERMISSIONS.ENTITY_CREATE]: 'Create a new entity (table) on a platform',
    [PERMISSIONS.ENTITY_READ]: "View an entity's definition",
    [PERMISSIONS.ENTITY_UPDATE]: "Update an entity's definition",
    [PERMISSIONS.ENTITY_DELETE]: 'Delete an entity',

    [PERMISSIONS.FIELD_CREATE]: 'Create a new field (column) on an entity',
    [PERMISSIONS.FIELD_READ]: "View a field's definition",
    [PERMISSIONS.FIELD_UPDATE]: "Update a field's definition",
    [PERMISSIONS.FIELD_DELETE]: 'Delete a field',

    [PERMISSIONS.FILE_MANAGE]: 'Delete or manage any uploaded file, regardless of ownership',
    [PERMISSIONS.PLANNING_READ]: 'View any platform planning, regardless of membership',
    [PERMISSIONS.PLANNING_MANAGE]: 'Create, edit, or delete any platform planning entry',

    [PERMISSIONS.CLIENT_CREATE]: 'Create a new client profile',
    [PERMISSIONS.CLIENT_READ]: 'View client profile details and contact information',
    [PERMISSIONS.CLIENT_UPDATE]: "Update client profile details, status, or internal notes",
    [PERMISSIONS.CLIENT_DELETE]: 'Permanently delete a client profile',
    [PERMISSIONS.CLIENT_MANAGE_TESTIMONIALS]: 'Approve, edit, or toggle public visibility of client reviews and testimonials',

    [PERMISSIONS.CONTRACT_CREATE]: 'Draft and create a new contract for a client',
    [PERMISSIONS.CONTRACT_READ]: 'View contract details, status, and financial information',
    [PERMISSIONS.CONTRACT_UPDATE]: 'Update contract parameters, upload signed documents, or change contract status',
    [PERMISSIONS.CONTRACT_DELETE]: 'Delete a contract record',

    [PERMISSIONS.PROJECT_CREATE]: 'Create a new project (product/feature idea)',
    [PERMISSIONS.PROJECT_READ]: "View any project's details, regardless of who manages it",
    [PERMISSIONS.PROJECT_UPDATE]: "Update any project's details, status, or manager",
    [PERMISSIONS.PROJECT_DELETE]: 'Delete a project',

    [PERMISSIONS.GENERATOR_EXECUTE]: 'Trigger the backend generation process for a platform',
    [PERMISSIONS.GENERATION_READ]: 'View generation history and logs',

    [PERMISSIONS.RUNTIME_MANAGE]: 'Start, stop, or inspect the running process of a generated backend',

    [PERMISSIONS.AUDIT_READ]: 'View the audit log of sensitive actions',

    [PERMISSIONS.BACKUP_MANAGE]: 'Export (dump) the orchestrator database or any platform database for backup/infra-migration purposes',

};