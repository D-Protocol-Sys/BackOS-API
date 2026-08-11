import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';

/**
 * Authorization Guard responsible for Role/Attribute-Based Access Control (RBAC/ABAC).
 * Evaluates whether an authenticated user possesses all mandatory permissions 
 * required to execute a specific route handler or controller.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {

    /**
     * @param reflector - Helper service used to read custom metadata attached via decorators.
     */
    constructor(private readonly reflector: Reflector) {}

    /**
     * Determines if the request satisfies the permission requirements.
     * * @param context - Execution details regarding the current request and target handler.
     * @returns `true` if authorized; otherwise throws a `ForbiddenException` (403 Forbidden).
     */
    canActivate(context: ExecutionContext): boolean {

        // Retrieves the array of permissions attached via `@RequirePermissions()`
        // Evaluates method-level metadata first, falling back to class-level metadata if present.
        const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
            PERMISSIONS_KEY,
            [context.getHandler(), context.getClass()],
        );

        // If no permissions are specified on the handler or controller, grant access by default.
        if (!requiredPermissions || requiredPermissions.length === 0) {
            return true;
        }

        // Extracts the HTTP Request object to inspect the user context
        const request = context.switchToHttp().getRequest();
        
        // Safely retrieves user permissions populated by JwtStrategy during authentication.
        // Falls back to an empty array if `request.user` or `permissions` is undefined.
        const userPermissions: string[] = request.user?.permissions || [];

        // Enforces an "ALL" match policy: the user must possess EVERY single required permission.
        const hasAll = requiredPermissions.every((p) => userPermissions.includes(p));
        
        if (!hasAll) {
            // Throws HTTP 403 Forbidden if one or more required permissions are missing.
            throw new ForbiddenException('Permissions insuffisantes.');
        }

        return true;
    }
}