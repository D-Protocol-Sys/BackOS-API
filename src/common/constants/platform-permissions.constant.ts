/**
 * Catalog of permissions that can be granted through a platform-scoped `PlatformRole` (see
 * `schema.prisma`). Distinct from `PERMISSIONS` in `permissions.constant.ts`, which is the
 * global, orchestrator-wide RBAC (who can manage BackOS itself, across every platform) - these
 * keys only ever mean something *inside one specific platform*.
 *
 * The system "ADMIN" role every platform is seeded with (see `PlatformsService.create()`) holds
 * every key in this catalog implicitly (see `PLATFORM_ADMIN_IMPLICIT_PERMISSIONS` below) - never
 * stored as `PlatformRolePermission` rows, so it can't be edited or stripped through the roles
 * API. Deliberately absent from this catalog entirely (i.e. NOT grantable to anyone, not even
 * ADMIN, not even by the owner explicitly picking permissions for a custom role): deleting a
 * platform, purging it, transferring its ownership, and outright regenerating without going
 * through the owner-approval step. Those stay actions only the actual owner can take, enforced
 * directly in `PlatformsService` / `GeneratorController`, never as a grantable permission.
 */
export const PLATFORM_PERMISSIONS = {

    // Platform (the platform's own settings - NOT delete/transfer/purge, see class doc above)
    PLATFORM_UPDATE: 'platform.update',
    PLATFORM_MANAGE_MEMBERS: 'platform.manage-members',
    PLATFORM_MANAGE_ROLES: 'platform.manage-roles',

    // Structure (entities/tables & fields/columns of the generated backend)
    ENTITY_MANAGE: 'entity.manage',
    FIELD_MANAGE: 'field.manage',

    // Data (records inside the generated backend's own tables - never the structure)
    DATA_CREATE: 'data.create',
    DATA_READ: 'data.read',
    DATA_UPDATE: 'data.update',
    DATA_DELETE: 'data.delete',

    // Generation & runtime (reading generation history/logs is NOT a grantable permission:
    // it is reserved to the owner and the ADMIN, see GeneratorController.assertCanReadGenerations)
    GENERATOR_EXECUTE: 'generator.execute',
    RUNTIME_MANAGE: 'runtime.manage',

    // Files & planning
    FILE_MANAGE: 'file.manage',
    PLANNING_READ: 'planning.read',
    PLANNING_MANAGE: 'planning.manage',

    // ARCH-001: the client.*, contract.* and project.* keys were removed. Clients, contracts and
    // projects are GLOBAL resources guarded by global permissions (see permissions.constant.ts);
    // no code ever checked these per-platform keys, so granting them in a custom role had no
    // effect and was misleading. PlatformPermissionsSyncService prunes them from the database
    // (and from every custom role) on the next boot.

} as const;

export type PlatformPermissionKey = (typeof PLATFORM_PERMISSIONS)[keyof typeof PLATFORM_PERMISSIONS];

export const PLATFORM_PERMISSION_DESCRIPTIONS: Record<PlatformPermissionKey, string> = {

    [PLATFORM_PERMISSIONS.PLATFORM_UPDATE]: "Update this platform's own settings (name, description, URL)",
    [PLATFORM_PERMISSIONS.PLATFORM_MANAGE_MEMBERS]: 'Add, remove, or change the role of members on this platform',
    [PLATFORM_PERMISSIONS.PLATFORM_MANAGE_ROLES]: 'Create, edit, or delete custom roles on this platform',

    [PLATFORM_PERMISSIONS.ENTITY_MANAGE]: 'Create, update, or delete entities (tables) on this platform',
    [PLATFORM_PERMISSIONS.FIELD_MANAGE]: 'Create, update, or delete fields (columns) on this platform',

    [PLATFORM_PERMISSIONS.DATA_CREATE]: "Create records in this platform's generated tables",
    [PLATFORM_PERMISSIONS.DATA_READ]: "Read records in this platform's generated tables",
    [PLATFORM_PERMISSIONS.DATA_UPDATE]: "Update records in this platform's generated tables",
    [PLATFORM_PERMISSIONS.DATA_DELETE]: "Delete records in this platform's generated tables",

    [PLATFORM_PERMISSIONS.GENERATOR_EXECUTE]: 'Trigger a backend generation for this platform (subject to owner approval if not triggered by the owner)',
    [PLATFORM_PERMISSIONS.RUNTIME_MANAGE]: "Start, stop, or inspect this platform's generated backend runtime",

    [PLATFORM_PERMISSIONS.FILE_MANAGE]: 'Delete or manage any uploaded file on this platform, regardless of ownership',
    [PLATFORM_PERMISSIONS.PLANNING_READ]: "View this platform's planning, regardless of membership",
    [PLATFORM_PERMISSIONS.PLANNING_MANAGE]: 'Create, edit, or delete this platform planning entries',

};

/**
 * The system ADMIN role's implicit permission set: every key in the catalog, i.e. everything
 * *grantable*. Computed once here rather than stored as `PlatformRolePermission` rows for the
 * ADMIN role - see `schema.prisma`'s `PlatformRole` doc comment for why.
 */
export const PLATFORM_ADMIN_IMPLICIT_PERMISSIONS: readonly PlatformPermissionKey[] =
    Object.values(PLATFORM_PERMISSIONS);

/** A quick suggestion for the "Data" role EDITOR/VIEWER are being replaced with - not a system
 *  constant, just what `DATA_OPERATOR` would look like if someone picks exactly this set. */
export const DATA_OPERATOR_SUGGESTED_PERMISSIONS: readonly PlatformPermissionKey[] = [
    PLATFORM_PERMISSIONS.DATA_CREATE,
    PLATFORM_PERMISSIONS.DATA_READ,
    PLATFORM_PERMISSIONS.DATA_UPDATE,
    PLATFORM_PERMISSIONS.DATA_DELETE,
];
