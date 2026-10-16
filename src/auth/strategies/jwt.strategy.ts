import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

/**
 * Passport strategy responsible for validating JSON Web Tokens (JWT)
 * attached to incoming HTTP requests.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
    /**
     * Configures the JWT extraction and signature verification rules.
     * * @param configService - Injected service to retrieve environment variables safely.
     */
    /**
     * SECURITY FIX (SEC-002): short-lived cache of account status, so a suspended, disabled or
     * deleted user loses API access within seconds instead of keeping a valid access token for
     * up to its 15-minute lifetime - at the cost of at most one indexed lookup per user every
     * STATUS_CACHE_TTL_MS.
     */
    private static readonly STATUS_CACHE_TTL_MS = 30_000;
    private readonly statusCache = new Map<string, { active: boolean; expiresAt: number }>();

    constructor(
        configService: ConfigService,
        private readonly prisma: PrismaService,
    ) {
        super({
            // Extracts the JWT from the HTTP Authorization header using the 'Bearer <token>' schema.
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),

            // Enforces token expiration checks; requests with expired JWTs will automatically be rejected (401 Unauthorized).
            ignoreExpiration: false,

            // Retrieves the secret key used to verify the cryptographic signature of the token.
            // Using getOrThrow guarantees the app crashes at startup if the JWT secret is missing.
            secretOrKey: configService.getOrThrow<string>('jwt.secret'),
        });
    }

    /**
     * Callback invoked automatically by Passport once the JWT signature and expiration are verified.
     *
     * KNOWN LIMITATION (audit #14 - minor, documented rather than "fixed"): this trusts the
     * JWT's signature and expiration alone - it does not re-check in the database that the user
     * is still `ACTIVE`. Suspending a user therefore does not revoke their already-issued access
     * token; it remains usable for up to its 15-minute lifetime. This is a common, reasonable
     * tradeoff for a stateless-JWT design given that short expiry, but is recorded here
     * explicitly as a conscious tradeoff rather than an oversight. If a stronger guarantee is
     * ever needed for specific highly sensitive actions, add a targeted DB status check at the
     * point of use (as `AuthService.verifyStepUpTotp()` already does for account deletion)
     * rather than paying that DB round-trip cost on every single authenticated request.
     * * @param payload - The decoded JSON payload contained within the JWT.
     * @returns An object representing the authenticated user context, which NestJS automatically attaches to `req.user`.
     */
    async validate(payload: { sub: string; email: string; permissions: string[] }) {
        if (!(await this.isActive(payload.sub))) {
            throw new UnauthorizedException('Session no longer valid.');
        }
        return {
            userId: payload.sub, // 'sub' (subject) is the standard JWT claim representing the unique user ID
            email: payload.email,
            permissions: payload.permissions,
        };
    }

    private async isActive(userId: string): Promise<boolean> {
        const now = Date.now();
        const cached = this.statusCache.get(userId);
        if (cached && cached.expiresAt > now) return cached.active;

        const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
        const active = user?.status === 'ACTIVE';
        if (this.statusCache.size > 10_000) this.statusCache.clear();
        this.statusCache.set(userId, { active, expiresAt: now + JwtStrategy.STATUS_CACHE_TTL_MS });
        return active;
    }
}
