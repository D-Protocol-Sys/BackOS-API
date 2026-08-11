import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Custom NestJS Parameter Decorator.
 * * Extracts the `user` object directly from the incoming HTTP request context,
 * allowing controllers to inject the authenticated user payload cleanly.
 * * @example
 * ```ts
 * @Get('profile')
 * getProfile(@CurrentUser() user: UserEntity) {
 * return user;
 * }
 * ```
 */
export const CurrentUser = createParamDecorator(
    /**
     * Factory function invoked by NestJS when the route handler runs.
     * * @param _data - Optional data passed to the decorator (unused here, prefixed with `_`).
     * @param ctx - The execution context containing request and pipeline metadata.
     * @returns The authenticated user attached to `request.user` by Passport/Guard.
     */
    (_data: unknown, ctx: ExecutionContext) => {
        // Switches the generic execution context to HTTP context and retrieves the Request object
        const request = ctx.switchToHttp().getRequest();
        
        // Returns the 'user' property attached to the request (populated by JwtStrategy / AuthGuard)
        return request.user;
    },
);