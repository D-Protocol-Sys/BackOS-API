import { SetMetadata } from '@nestjs/common';
import { PermissionKey } from '../constants/permissions.constant';
import type { FeaturePermissionKey } from '../../features/feature.types';

/**
 * Metadata key used to store the array of permissions required to access a route or controller.
 * Exported as a constant to ensure consistency when read by Guards via Reflector.
 */
export const PERMISSIONS_KEY = 'requiredPermissions';

/**
 * Custom Decorator `@RequirePermissions()`
 * * Attaches one or more required permission keys to a route handler or class metadata.
 * A permission guard (e.g., `PermissionsGuard`) inspects this metadata at runtime
 * to determine if the authenticated user has the necessary privileges.
 * * @param permissions - Rest parameter accepting one or multiple valid `PermissionKey` values.
 * * @example
 * ```ts
 * @RequirePermissions(PermissionKey.USERS_CREATE, PermissionKey.USERS_DELETE)
 * @Post('users')
 * createUsers() { ... }
 * ```
 */
export const RequirePermissions = (...permissions: Array<PermissionKey | FeaturePermissionKey>) =>
    SetMetadata(PERMISSIONS_KEY, permissions);