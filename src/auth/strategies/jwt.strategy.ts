import { Injectable } from '@nestjs/common';
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
    constructor(configService: ConfigService) {
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
     * * @param payload - The decoded JSON payload contained within the JWT.
     * @returns An object representing the authenticated user context, which NestJS automatically attaches to `req.user`.
     */
    async validate(payload: { sub: string; email: string; permissions: string[] }) {
        return {
            userId: payload.sub, // 'sub' (subject) is the standard JWT claim representing the unique user ID
            email: payload.email,
            permissions: payload.permissions,
        };
    }
}