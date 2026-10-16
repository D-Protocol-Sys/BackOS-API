import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Global authentication guard extending Passport's built-in JWT guard.
 * Intercepts incoming requests to verify JWT credentials unless explicitly marked as public.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
    /**
     * @param reflector - Helper service used to retrieve custom metadata attached to route handlers or controllers.
     */
    constructor(private readonly reflector: Reflector) {
        super();
    }

    /**
     * Determines whether the current request is allowed to proceed.
     * * @param context - Execution details regarding the current pipeline and endpoint handler.
     * @returns `true` if public or successfully authenticated; otherwise delegates to `AuthGuard('jwt')`.
     */
    canActivate(context: ExecutionContext) {
        // Checks for the `@Public()` decorator metadata on either the handler (method) or class (controller).
        // Method-level metadata overrides class-level metadata if present.
        const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);

        // Opt-out mechanism: Allows immediate access without validating JWT signatures for public routes.
        if (isPublic) return true;

        // Delegates authentication to Passport's default 'jwt' strategy pipeline for protected routes.
        return super.canActivate(context);
    }
}
