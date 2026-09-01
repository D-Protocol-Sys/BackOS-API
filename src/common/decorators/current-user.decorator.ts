import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Custom NestJS Parameter Decorator.
 * * Extracts the `user` object directly from the incoming HTTP request context,
 * allowing controllers to inject the authenticated user payload cleanly. Optionally
 * accepts a single property key to project just that field instead of the whole object.
 * * @example
 * ```ts
 * // Whole payload - matches the shape returned by JwtStrategy.validate():
 * // { userId: string; email: string; permissions: string[] }
 * @Get('profile')
 * getProfile(@CurrentUser() user: { userId: string }) {
 *   return user.userId;
 * }
 *
 * // Single-field projection - equivalent to `user.userId`, but inline at the handler signature:
 * @Delete('me')
 * deleteMe(@CurrentUser('userId') userId: string) {
 *   return this.usersService.hardDeleteUser(userId, userId);
 * }
 * ```
 *
 * BUG FIX: the previous implementation silently ignored the `data` argument and always
 * returned the entire `request.user` object, regardless of what key was requested. Any
 * call site written as `@CurrentUser('someKey') foo: string` therefore received the WHOLE
 * user object instead of a string - a real bug found in `clients.controller.ts`, where
 * `@CurrentUser('id')` was passed straight through to `ClientsService` methods and to
 * `AuditLogService.log({ actorId: ... })` expecting a plain string ID. That call also used
 * the wrong property name (`'id'`), since `JwtStrategy.validate()` attaches `{ userId, email,
 * permissions }` to the request - there is no `id` field. Both issues are fixed: the
 * decorator now actually projects the requested key when one is provided, and the call
 * sites were updated to request `'userId'`.
 */
export const CurrentUser = createParamDecorator(
    /**
     * Factory function invoked by NestJS when the route handler runs.
     * * @param data - Optional property key to project from the user object (e.g. `'userId'`).
     *   When omitted, the full user object is returned, preserving the original behaviour.
     * @param ctx - The execution context containing request and pipeline metadata.
     * @returns The authenticated user (or a single field of it) attached to `request.user`
     *   by Passport/Guard.
     */
    (data: string | undefined, ctx: ExecutionContext) => {
        // Switches the generic execution context to HTTP context and retrieves the Request object
        const request = ctx.switchToHttp().getRequest();

        // Returns the 'user' property attached to the request (populated by JwtStrategy / AuthGuard)
        const user = request.user;

        // When a key is requested, project just that field; otherwise return the whole object.
        return data ? user?.[data] : user;
    },
);