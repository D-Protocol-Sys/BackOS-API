import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * SECURITY FIX (SEC-024): the public demo account's TOTP secret is published on purpose, so
 * "read-only" must be enforced by the server, not only by its role: routes without
 * `@RequirePermissions` (messages, uploads, personal planning, profile, account deletion...)
 * were writable by anyone holding the demo code. Every non-read request made by the account
 * named in DEMO_WORKEMAIL is refused, except logging out.
 */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALLOWED_WRITE_PATHS = [/\/auth\/logout$/, /\/auth\/refresh$/];

@Injectable()
export class DemoReadOnlyGuard implements CanActivate {
    constructor(private readonly configService: ConfigService) {}

    canActivate(context: ExecutionContext): boolean {
        const demoEmail = this.configService.get<string>('DEMO_WORKEMAIL');
        if (!demoEmail) return true;

        const request = context.switchToHttp().getRequest();
        const user = request.user as { email?: string } | undefined;
        if (!user?.email || user.email.toLowerCase() !== demoEmail.toLowerCase()) return true;
        if (READ_METHODS.has(request.method)) return true;
        if (ALLOWED_WRITE_PATHS.some((pattern) => pattern.test(request.path ?? request.url ?? ''))) return true;

        throw new ForbiddenException('The demo account is read-only.');
    }
}
