import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key used to flag routes or controllers as public (unauthenticated).
 * Stored as a constant to prevent typos when referenced across Guards and Decorators.
 */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Custom Decorator `@Public()`
 * * Attaches custom metadata (`isPublic = true`) to a route handler or class.
 * * When used, a global authentication guard (e.g., `JwtAuthGuard`) reads this metadata
 * via NestJS `Reflector` and skips authentication verification for the endpoint.
 * * @example
 * ```ts
 * @Public()
 * @Post('login')
 * async login(@Body() dto: LoginDto) { ... }
 * ```
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);