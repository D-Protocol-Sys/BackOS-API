import * as fs from 'fs/promises';
import * as path from 'path';
import { toCamelCase } from '../../../common/utils/case.util';
import { FIELD_TYPE_VALIDATORS } from '../../../common/utils/field-type-validator-mapper.util';
import { buildDtoFieldsSource, collectFieldValidatorImports } from '../../../common/utils/dto-field-builder.util';
import { isExternalUsersEnabled } from '../blueprints/auth-user.prisma-models';
import { readProfileFields } from '../profile-fields.util';

export interface BlueprintModuleRef {
    name: string;
    importPath: string;
}

/**
 * Generates the source of the "Auth & User" service into a generated backend.
 *
 * Two independent login methods (see `AUTH_USER_BLUEPRINT`):
 *
 *   INTERNAL - always generated. `POST /auth/internal/login { username, code }`: the BackOS
 *   username of whoever generated the backend + their CURRENT authenticator (TOTP) code. The code
 *   is checked by BackOS (`BackosVerifierService`), never locally: the generated backend does not
 *   hold anyone's TOTP secret, so compromising it cannot leak the credentials that also open BackOS.
 *   The accounts themselves are created automatically at start-up from `INTERNAL_ACCOUNTS`, which
 *   BackOS writes into `.env` on every generation (see `ProjectScaffolderService`).
 *
 *   EXTERNAL - generated only when `allowExternalUsers` is on. Sign-up = last name + first name +
 *   e-mail + the code e-mailed to that address; login = e-mail + a fresh e-mailed code. Once
 *   signed up, the user fills in the profile whose fields the platform owner defined
 *   (`PATCH /users/me/profile`).
 *
 * Files are written with `String.raw` and deliberately avoid backticks and `${...}` inside the
 * generated code (plain string concatenation instead) so that only the dynamic parts of this
 * generator are ever interpolated.
 */
export async function generateAuthUserFiles(
    projectPath: string,
    config: Record<string, unknown>,
): Promise<BlueprintModuleRef[]> {

    const externalUsers = isExternalUsersEnabled(config);
    const profileFields = externalUsers ? readProfileFields(config) : [];

    await fs.mkdir(path.join(projectPath, 'src', 'auth', 'dto'), { recursive: true });
    await fs.mkdir(path.join(projectPath, 'src', 'auth', 'strategies'), { recursive: true });
    await fs.mkdir(path.join(projectPath, 'src', 'users', 'dto'), { recursive: true });
    await fs.mkdir(path.join(projectPath, 'src', 'common', 'decorators'), { recursive: true });
    await fs.mkdir(path.join(projectPath, 'src', 'common', 'guards'), { recursive: true });

    const files: Record<string, string> = {

        'src/common/decorators/public.decorator.ts': String.raw`
            import { SetMetadata } from '@nestjs/common';

            export const IS_PUBLIC_KEY = 'isPublic';
            export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
        `,

        'src/common/decorators/current-user.decorator.ts': String.raw`
            import { createParamDecorator, ExecutionContext } from '@nestjs/common';

            export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
                return ctx.switchToHttp().getRequest().user;
            });
        `,

        'src/common/guards/jwt-auth.guard.ts': String.raw`
            import { Injectable, ExecutionContext } from '@nestjs/common';
            import { AuthGuard } from '@nestjs/passport';
            import { Reflector } from '@nestjs/core';
            import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

            @Injectable()
            export class JwtAuthGuard extends AuthGuard('jwt') {
                constructor(private readonly reflector: Reflector) {
                    super();
                }

                canActivate(context: ExecutionContext) {
                    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
                        context.getHandler(),
                        context.getClass(),
                    ]);
                    if (isPublic) return true;
                    return super.canActivate(context);
                }
            }
        `,

        'src/common/guards/internal-only.guard.ts': String.raw`
            import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

            /**
             * Use AFTER JwtAuthGuard: @UseGuards(JwtAuthGuard, InternalOnlyGuard).
             * External users are visitors / customers - they may use the product but hold no
             * administration right, so every route that creates, changes, deletes or sends
             * something on the platform's behalf is reserved to internal accounts.
             */
            @Injectable()
            export class InternalOnlyGuard implements CanActivate {
                canActivate(context: ExecutionContext): boolean {
                    const user = context.switchToHttp().getRequest().user;
                    if (user?.type !== 'internal') {
                        throw new ForbiddenException('Action réservée aux comptes internes.');
                    }
                    return true;
                }
            }
        `,

        'src/common/guards/unpublished-access.guard.ts': String.raw`
            import { ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
            import { AuthGuard } from '@nestjs/passport';

            /**
             * For the read routes of a SCHEDULABLE entity (availability window: publishAt / unpublishAt).
             *
             * Everybody sees only PUBLISHED records. Asking for the unpublished ones too
             * (?includeUnpublished=true) is an administrative privilege:
             *   - without a valid access token   -> 401
             *   - with an external user's token  -> 403  (a visitor only sees what the team chose to show)
             *   - with an internal account's     -> allowed
             * Requests that do not ask for unpublished records pass straight through, token or not.
             */
            @Injectable()
            export class UnpublishedAccessGuard extends AuthGuard('jwt') {
                async canActivate(context: ExecutionContext): Promise<boolean> {
                    const request = context.switchToHttp().getRequest();
                    if (request.query?.includeUnpublished !== 'true') return true;

                    // Validates the bearer token (throws 401 when it is missing or invalid) and sets request.user.
                    const authenticated = (await super.canActivate(context)) as boolean;
                    if (!authenticated) return false;

                    if (request.user?.type !== 'internal') {
                        throw new ForbiddenException('Seuls les comptes internes peuvent voir les éléments non publiés.');
                    }
                    return true;
                }
            }
        `,

        'src/auth/auth.types.ts': String.raw`
            /** Who is behind a token: BackOS staff ("internal") or a visitor / customer ("external"). */
            export type AccountType = 'internal' | 'external';

            /** What JwtStrategy puts on req.user - read it with the @CurrentUser() decorator. */
            export interface AuthenticatedUser {
                userId: string;
                type: AccountType;
                email?: string;
                username?: string;
            }

            export type TokenSubject =
                | { kind: 'internal'; id: string; username: string }
                | { kind: 'external'; id: string; email: string };
        `,

        'src/auth/dto/internal-login.dto.ts': String.raw`
            import { IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';
            import { Transform } from 'class-transformer';

            export class InternalLoginDto {
                /** Your BackOS username. */
                @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
                @IsString()
                @MinLength(1)
                @MaxLength(100)
                username!: string;

                /** The 6-digit code currently shown by your authenticator app (the one you use on BackOS). */
                @Transform(({ value }) => (typeof value === 'string' ? value.replace(/\s+/g, '') : value))
                @IsString()
                @Length(6, 6)
                @Matches(/^[0-9]{6}$/)
                code!: string;
            }
        `,

        'src/auth/dto/create-internal-account.dto.ts': String.raw`
            import { IsString, MaxLength, MinLength } from 'class-validator';
            import { Transform } from 'class-transformer';

            /**
             * Grants internal (administrator) access on this backend to a BackOS user, identified by
             * their BackOS username. Only an existing internal account may do this (see
             * InternalOnlyGuard on the controller route) - there is no bootstrap problem because the
             * platform owner (and whoever triggered the generation) already have one, seeded at
             * start-up from INTERNAL_ACCOUNTS.
             */
            export class CreateInternalAccountDto {
                @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
                @IsString()
                @MinLength(1)
                @MaxLength(100)
                username!: string;
            }
        `,

        'src/auth/dto/refresh-token.dto.ts': String.raw`
            import { IsString } from 'class-validator';

            export class RefreshTokenDto {
                @IsString()
                refreshToken!: string;
            }
        `,

        'src/auth/strategies/jwt.strategy.ts': String.raw`
            import { Injectable, UnauthorizedException } from '@nestjs/common';
            import { PassportStrategy } from '@nestjs/passport';
            import { ExtractJwt, Strategy } from 'passport-jwt';
            import { AuthenticatedUser } from '../auth.types';

            @Injectable()
            export class JwtStrategy extends PassportStrategy(Strategy) {
                constructor() {
                    super({
                        jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
                        ignoreExpiration: false,
                        secretOrKey: process.env.JWT_SECRET || (() => {
                            throw new Error('JWT_SECRET is required.');
                        })(),
                    });
                }

                validate(payload: { sub: string; type?: string; email?: string; username?: string }): AuthenticatedUser {
                    // Tokens issued before the internal / external split carry no "type" - refuse them.
                    if (payload.type !== 'internal' && payload.type !== 'external') {
                        throw new UnauthorizedException();
                    }
                    return { userId: payload.sub, type: payload.type, email: payload.email, username: payload.username };
                }
            }
        `,

        'src/auth/backos-verifier.service.ts': String.raw`
            import { Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
            import { createHash, timingSafeEqual } from 'crypto';

            export interface VerifiedIdentity {
                userId: string;
                username: string;
            }

            /**
             * Asks BackOS - the only system that holds anyone's authenticator (TOTP) secret - to
             * vouch for an internal account. Authenticated with a per-platform secret
             * (INTERNAL_AUTH_KEY) that BackOS generated when Auth & User was enabled.
             */
            @Injectable()
            export class BackosVerifierService {
                private readonly logger = new Logger(BackosVerifierService.name);

                /** Full check: is this the BackOS user's CURRENT authenticator code? */
                verifyTotp(backosUserId: string, code: string): Promise<VerifiedIdentity> {
                    return this.post('verify', { userId: backosUserId, totpCode: code });
                }

                /**
                 * Lighter check with no code, used when a session is renewed: is this person still an
                 * active owner / member of the platform in BackOS? Without it, someone removed from the
                 * team would keep access for as long as their refresh token lives.
                 */
                async assertStillAuthorized(backosUserId: string): Promise<void> {
                    await this.post('session-check', { userId: backosUserId });
                }

                /**
                 * Resolves a BackOS username to that person's BackOS user id - but ONLY if they
                 * currently own or belong to THIS platform in BackOS. Used when granting internal
                 * access to someone: BackOS is the single source of truth for who is actually part of
                 * the platform, so this backend never has to keep its own copy of that membership list.
                 * Returns \`null\` for an unknown username or someone no longer on the platform, rather
                 * than throwing - that is an expected, common outcome here, not a failure.
                 */
                async lookupMember(username: string): Promise<VerifiedIdentity | null> {
                    const baseUrl = (process.env.BACKOS_URL ?? '').replace(/\/+$/, '');
                    const platformId = process.env.BACKOS_PLATFORM_ID;
                    const internalKey = process.env.INTERNAL_AUTH_KEY;
                    if (!baseUrl || !platformId || !internalKey) {
                        throw new ServiceUnavailableException('Internal authentication is not configured on this backend.');
                    }

                    let response: Response;
                    try {
                        response = await fetch(baseUrl + '/api/internal/generated-auth/lookup-member', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'X-Backos-Platform-Id': platformId,
                                'X-Backos-Internal-Key': internalKey,
                            },
                            body: JSON.stringify({ username }),
                            signal: AbortSignal.timeout(8000),
                        });
                    } catch (error) {
                        this.logger.error('BackOS is unreachable at ' + baseUrl + ': ' + (error instanceof Error ? error.message : String(error)));
                        throw new ServiceUnavailableException('Could not reach BackOS to look up this member.');
                    }

                    if (response.status === 404) return null;
                    if (response.status === 401 || response.status === 403) {
                        throw new ServiceUnavailableException('This backend is not authorized to query BackOS.');
                    }
                    if (!response.ok) {
                        throw new ServiceUnavailableException('Could not reach BackOS to look up this member.');
                    }
                    return (await response.json()) as VerifiedIdentity;
                }

                /**
                 * The CURRENT list of people who hold an internal account on this backend, straight
                 * from BackOS (the owner, every ADMIN and every holder of a role with data
                 * permissions). Returns \`null\` when BackOS cannot be reached or refuses, so a
                 * caller never wipes accounts because of a mere outage.
                 */
                async listInternalAccounts(): Promise<VerifiedIdentity[] | null> {
                    const baseUrl = (process.env.BACKOS_URL ?? '').replace(/\/+$/, '');
                    const platformId = process.env.BACKOS_PLATFORM_ID;
                    const internalKey = process.env.INTERNAL_AUTH_KEY;
                    if (!baseUrl || !platformId || !internalKey) return null;

                    try {
                        const response = await fetch(baseUrl + '/api/internal/generated-auth/internal-accounts', {
                            method: 'POST',
                            headers: {
                                'X-Backos-Platform-Id': platformId,
                                'X-Backos-Internal-Key': internalKey,
                            },
                            signal: AbortSignal.timeout(8000),
                        });
                        if (!response.ok) {
                            this.logger.warn('BackOS answered ' + response.status + ' when listing internal accounts.');
                            return null;
                        }
                        const accounts = (await response.json()) as VerifiedIdentity[];
                        return Array.isArray(accounts) ? accounts : null;
                    } catch (error) {
                        this.logger.warn('BackOS is unreachable at ' + baseUrl + ': ' + (error instanceof Error ? error.message : String(error)));
                        return null;
                    }
                }

                /**
                 * Proves the caller of a "resync" ping is BackOS: the presented key must equal this
                 * backend's INTERNAL_AUTH_KEY (constant-time comparison). Throws otherwise.
                 */
                assertCallerIsBackos(presentedKey: string | undefined): void {
                    const expectedKey = process.env.INTERNAL_AUTH_KEY;
                    if (!expectedKey || !presentedKey) throw new UnauthorizedException('Invalid credentials.');
                    const expected = createHash('sha256').update(expectedKey).digest();
                    const presented = createHash('sha256').update(presentedKey).digest();
                    if (!timingSafeEqual(expected, presented)) throw new UnauthorizedException('Invalid credentials.');
                }

                private async post(route: 'verify' | 'session-check', body: Record<string, unknown>): Promise<VerifiedIdentity> {
                    const baseUrl = (process.env.BACKOS_URL ?? '').replace(/\/+$/, '');
                    const platformId = process.env.BACKOS_PLATFORM_ID;
                    const internalKey = process.env.INTERNAL_AUTH_KEY;

                    if (!baseUrl || !platformId || !internalKey) {
                        this.logger.error('BACKOS_URL / BACKOS_PLATFORM_ID / INTERNAL_AUTH_KEY are not all set - regenerate this backend.');
                        throw new ServiceUnavailableException('Internal authentication is not configured on this backend.');
                    }

                    let response: Response;
                    try {
                        response = await fetch(baseUrl + '/api/internal/generated-auth/' + route, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'X-Backos-Platform-Id': platformId,
                                'X-Backos-Internal-Key': internalKey,
                            },
                            body: JSON.stringify(body),
                            signal: AbortSignal.timeout(8000),
                        });
                    } catch (error) {
                        this.logger.error('BackOS is unreachable at ' + baseUrl + ': ' + (error instanceof Error ? error.message : String(error)));
                        throw new ServiceUnavailableException('Internal authentication is temporarily unavailable.');
                    }

                    if (response.status === 401 || response.status === 403) {
                        throw new UnauthorizedException('Invalid credentials.');
                    }
                    if (!response.ok) {
                        this.logger.error('BackOS answered ' + response.status + ' on ' + route + '.');
                        throw new ServiceUnavailableException('Internal authentication is temporarily unavailable.');
                    }
                    return (await response.json()) as VerifiedIdentity;
                }
            }
        `,

        'src/auth/token.service.ts': String.raw`
            import { Injectable, UnauthorizedException } from '@nestjs/common';
            import { JwtService } from '@nestjs/jwt';
            import * as crypto from 'crypto';
            import { PrismaService } from '../prisma/prisma.service';
            import { BackosVerifierService } from './backos-verifier.service';
            import { AuthenticatedUser, TokenSubject } from './auth.types';

            const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

            /** Issues, rotates and revokes tokens - shared by internal and external accounts. */
            @Injectable()
            export class TokenService {
                constructor(
                    private readonly prisma: PrismaService,
                    private readonly jwtService: JwtService,
                    private readonly backos: BackosVerifierService,
                ) {}

                async issue(subject: TokenSubject) {
                    const payload =
                        subject.kind === 'internal'
                            ? { sub: subject.id, type: 'internal', username: subject.username }
                            : { sub: subject.id, type: 'external', email: subject.email };
                    const accessToken = this.jwtService.sign(payload);

                    const rawRefreshToken = crypto.randomBytes(64).toString('hex');
                    await this.prisma.appRefreshToken.create({
                        data: {
                            tokenHash: this.hash(rawRefreshToken),
                            expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
                            ...(subject.kind === 'internal' ? { internalAccountId: subject.id } : { userId: subject.id }),
                        },
                    });

                    return { accessToken, refreshToken: rawRefreshToken, accountType: subject.kind };
                }

                async refresh(rawRefreshToken: string) {
                    const stored = await this.prisma.appRefreshToken.findUnique({
                        where: { tokenHash: this.hash(rawRefreshToken) },
                        include: { user: true, internalAccount: true },
                    });

                    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
                        throw new UnauthorizedException('Invalid session.');
                    }

                    let subject: TokenSubject;
                    if (stored.internalAccount) {
                        if (!stored.internalAccount.isActive) throw new UnauthorizedException('Invalid session.');
                        // Re-checked BEFORE rotating, so an unreachable BackOS never burns a valid token.
                        await this.backos.assertStillAuthorized(stored.internalAccount.backosUserId);
                        subject = { kind: 'internal', id: stored.internalAccount.id, username: stored.internalAccount.username };
                    } else if (stored.user) {
                        if (!stored.user.isActive) throw new UnauthorizedException('Invalid session.');
                        subject = { kind: 'external', id: stored.user.id, email: stored.user.email };
                    } else {
                        throw new UnauthorizedException('Invalid session.');
                    }

                    // Rotation: the token is single-use. Claiming it atomically means two concurrent
                    // refreshes with the same token cannot both succeed.
                    const claimed = await this.prisma.appRefreshToken.updateMany({
                        where: { id: stored.id, revokedAt: null },
                        data: { revokedAt: new Date() },
                    });
                    if (claimed.count !== 1) throw new UnauthorizedException('Invalid session.');

                    return this.issue(subject);
                }

                /** Revokes a refresh token - only if it belongs to the caller. */
                async revoke(rawRefreshToken: string, user: AuthenticatedUser) {
                    await this.prisma.appRefreshToken.updateMany({
                        where: {
                            tokenHash: this.hash(rawRefreshToken),
                            revokedAt: null,
                            ...(user.type === 'internal' ? { internalAccountId: user.userId } : { userId: user.userId }),
                        },
                        data: { revokedAt: new Date() },
                    });
                    return { message: 'Logged out.' };
                }

                private hash(rawToken: string): string {
                    return crypto.createHash('sha256').update(rawToken).digest('hex');
                }
            }
        `,

        'src/auth/internal-auth.service.ts': String.raw`
            import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit, UnauthorizedException } from '@nestjs/common';
            import { PrismaService } from '../prisma/prisma.service';
            import { BackosVerifierService } from './backos-verifier.service';
            import { TokenService } from './token.service';
            import { InternalLoginDto } from './dto/internal-login.dto';
            import { CreateInternalAccountDto } from './dto/create-internal-account.dto';

            /**
             * Internal accounts: the BackOS people who may work on this backend - the owner, every
             * ADMIN of the platform and every member whose role has data permissions. BackOS is
             * the source of truth: the list is pulled from it at start-up and again each time BackOS
             * pings \`POST /auth/internal/sync\` after a role change, so accounts appear (or are
             * revoked) immediately, without restarting or regenerating this backend.
             * Log in with BackOS username + current authenticator code.
             */
            @Injectable()
            export class InternalAuthService implements OnModuleInit {
                private readonly logger = new Logger(InternalAuthService.name);

                constructor(
                    private readonly prisma: PrismaService,
                    private readonly backos: BackosVerifierService,
                    private readonly tokens: TokenService,
                ) {}

                async onModuleInit() {
                    // The live list from BackOS wins. INTERNAL_ACCOUNTS (written at generation time)
                    // is only the fallback when BackOS cannot be reached at start-up.
                    const synced = await this.syncFromBackos();
                    if (!synced) await this.seedInternalAccounts();
                }

                /**
                 * Reconciles this backend's internal accounts with BackOS's live list: creates or
                 * reactivates everyone on it, and deactivates (soft, audit trail kept) anyone no
                 * longer on it. Idempotent. Returns \`false\`, changing nothing, when BackOS could not
                 * be reached - an outage must never lock people out or wipe accounts.
                 */
                async syncFromBackos(): Promise<boolean> {
                    const accounts = await this.backos.listInternalAccounts();
                    if (!accounts) return false;

                    for (const account of accounts) {
                        try {
                            await this.prisma.appInternalAccount.upsert({
                                where: { backosUserId: account.userId },
                                update: { username: account.username, isActive: true },
                                create: { backosUserId: account.userId, username: account.username },
                            });
                        } catch (error) {
                            this.logger.error('Could not sync the internal account "' + account.username + '": ' + (error instanceof Error ? error.message : String(error)));
                        }
                    }

                    // An empty list would deactivate everyone - treat it as "nothing to trust".
                    if (accounts.length > 0) {
                        await this.prisma.appInternalAccount.updateMany({
                            where: { isActive: true, backosUserId: { notIn: accounts.map((account) => account.userId) } },
                            data: { isActive: false },
                        });
                    }

                    this.logger.log('Internal accounts synced with BackOS (' + accounts.length + ').');
                    return true;
                }

                async login(dto: InternalLoginDto) {
                    const account = await this.prisma.appInternalAccount.findFirst({
                        where: { username: { equals: dto.username, mode: 'insensitive' }, isActive: true },
                    });
                    // Same answer for "unknown username" and "wrong code".
                    if (!account) throw new UnauthorizedException('Invalid credentials.');

                    await this.backos.verifyTotp(account.backosUserId, dto.code);

                    return this.tokens.issue({ kind: 'internal', id: account.id, username: account.username });
                }

                /** Every internal account on this backend - the "Users" tab's internal list. */
                async list() {
                    return this.prisma.appInternalAccount.findMany({
                        select: { id: true, username: true, isActive: true, createdAt: true },
                        orderBy: { createdAt: 'asc' },
                    });
                }

                /**
                 * Grants internal access to a BackOS user by username. Only reachable by an existing
                 * internal account (see InternalOnlyGuard on the controller route) - the platform
                 * owner and whoever triggered the last generation always have one already, seeded at
                 * start-up, so there is no bootstrap gap. \`BackosVerifierService.lookupMember()\` is
                 * what actually confirms the username belongs to this platform before an account is
                 * created for it.
                 *
                 * Upserts by BackOS user id rather than blindly inserting: granting access again to
                 * someone previously deactivated simply reactivates their existing account (and
                 * refreshes their username, in case it changed) instead of erroring or duplicating.
                 */
                async createAccount(dto: CreateInternalAccountDto) {
                    const identity = await this.backos.lookupMember(dto.username);
                    if (!identity) {
                        throw new BadRequestException('No member of this platform has that BackOS username.');
                    }

                    const account = await this.prisma.appInternalAccount.upsert({
                        where: { backosUserId: identity.userId },
                        update: { username: identity.username, isActive: true },
                        create: { backosUserId: identity.userId, username: identity.username },
                    });
                    this.logger.log('Internal account granted: ' + account.username);
                    return account;
                }

                /**
                 * Revokes internal access. Soft (\`isActive: false\`), not a delete: keeps the account's
                 * audit trail (refresh tokens, references) intact, and \`TokenService.refresh()\`
                 * already refuses an inactive account, so this takes effect immediately - the person
                 * cannot renew their session even if their current access token has not expired yet.
                 */
                async deactivate(id: string) {
                    const account = await this.prisma.appInternalAccount.findUnique({ where: { id } });
                    if (!account) throw new NotFoundException('Internal account not found.');
                    await this.prisma.appInternalAccount.update({ where: { id }, data: { isActive: false } });
                    return { message: 'Internal access revoked.' };
                }

                /**
                 * Creates / refreshes the internal accounts BackOS listed for this backend. Runs at every
                 * start-up and is idempotent: BackOS rewrites INTERNAL_ACCOUNTS (base64 JSON) on each
                 * generation, so a changed username or a new owner is picked up without any manual step.
                 */
                private async seedInternalAccounts() {
                    const raw = process.env.INTERNAL_ACCOUNTS;
                    if (!raw) return;

                    let accounts: { userId: string; username: string }[];
                    try {
                        accounts = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
                        if (!Array.isArray(accounts)) throw new Error('not an array');
                    } catch (error) {
                        this.logger.error('INTERNAL_ACCOUNTS is not valid - internal accounts were NOT created: ' + (error instanceof Error ? error.message : String(error)));
                        return;
                    }

                    for (const account of accounts) {
                        try {
                            await this.prisma.appInternalAccount.upsert({
                                where: { backosUserId: account.userId },
                                update: { username: account.username, isActive: true },
                                create: { backosUserId: account.userId, username: account.username },
                            });
                            this.logger.log('Internal account ready: ' + account.username);
                        } catch (error) {
                            this.logger.error('Could not create the internal account "' + account.username + '": ' + (error instanceof Error ? error.message : String(error)));
                        }
                    }
                }
            }
        `,

        'src/auth/auth.controller.ts': String.raw`
            import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
            import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
            import { InternalAuthService } from './internal-auth.service';
            import { BackosVerifierService } from './backos-verifier.service';
            import { TokenService } from './token.service';
            import { InternalLoginDto } from './dto/internal-login.dto';
            import { RefreshTokenDto } from './dto/refresh-token.dto';
            import { CreateInternalAccountDto } from './dto/create-internal-account.dto';
            import { AuthenticatedUser } from './auth.types';
            import { Public } from '../common/decorators/public.decorator';
            import { CurrentUser } from '../common/decorators/current-user.decorator';
            import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
            import { InternalOnlyGuard } from '../common/guards/internal-only.guard';

            @ApiTags('Auth')
            @Controller('auth')
            export class AuthController {
                constructor(
                    private readonly internalAuth: InternalAuthService,
                    private readonly tokens: TokenService,
                    private readonly backos: BackosVerifierService,
                ) {}

                /**
                 * Machine-to-machine ping from BackOS (never a browser): "a member or role changed,
                 * pull the internal accounts again". Carries no data - the accounts always come from
                 * BackOS's own answer, so a forged ping can at worst trigger a harmless re-read.
                 * Authenticated by the INTERNAL_AUTH_KEY header, not a user session.
                 */
                @Public()
                @ApiExcludeEndpoint()
                @Post('internal/sync')
                @HttpCode(200)
                async syncInternalAccounts(@Headers('x-backos-internal-key') presentedKey: string | undefined) {
                    this.backos.assertCallerIsBackos(presentedKey);
                    return { synced: await this.internalAuth.syncFromBackos() };
                }

                /** Internal login: BackOS username + the 6-digit code from your authenticator app. */
                @Public()
                @Post('internal/login')
                @HttpCode(200)
                internalLogin(@Body() dto: InternalLoginDto) {
                    return this.internalAuth.login(dto);
                }

                @Public()
                @Post('refresh')
                @HttpCode(200)
                refresh(@Body() dto: RefreshTokenDto) {
                    return this.tokens.refresh(dto.refreshToken);
                }

                @UseGuards(JwtAuthGuard)
                @ApiBearerAuth('access-token')
                @Post('logout')
                @HttpCode(200)
                logout(@CurrentUser() user: AuthenticatedUser, @Body() dto: RefreshTokenDto) {
                    return this.tokens.revoke(dto.refreshToken, user);
                }

                /**
                 * Every route below manages INTERNAL accounts (administrators of this backend) and is
                 * reserved to existing internal accounts - never to an external user, whatever entity
                 * permissions they might otherwise have. The platform owner and whoever triggered the
                 * last generation always have one already (seeded at start-up), so this is never a
                 * bootstrap dead end.
                 */
                @UseGuards(JwtAuthGuard, InternalOnlyGuard)
                @ApiBearerAuth('access-token')
                @Get('internal/accounts')
                listInternalAccounts() {
                    return this.internalAuth.list();
                }

                @UseGuards(JwtAuthGuard, InternalOnlyGuard)
                @ApiBearerAuth('access-token')
                @Post('internal/accounts')
                createInternalAccount(@Body() dto: CreateInternalAccountDto) {
                    return this.internalAuth.createAccount(dto);
                }

                @UseGuards(JwtAuthGuard, InternalOnlyGuard)
                @ApiBearerAuth('access-token')
                @Delete('internal/accounts/:id')
                deactivateInternalAccount(@Param('id') id: string) {
                    return this.internalAuth.deactivate(id);
                }
            }
        `,

        'src/auth/auth.module.ts': String.raw`
            import { Module } from '@nestjs/common';
            import { JwtModule, type JwtSignOptions } from '@nestjs/jwt';
            import { PassportModule } from '@nestjs/passport';
            import { AuthController } from './auth.controller';
            import { TokenService } from './token.service';
            import { BackosVerifierService } from './backos-verifier.service';
            import { InternalAuthService } from './internal-auth.service';
            import { JwtStrategy } from './strategies/jwt.strategy';
            ${externalUsers ? "import { ExternalAuthController } from './external-auth.controller';\nimport { ExternalAuthService } from './external-auth.service';" : ''}

            const jwtExpiresIn = (process.env.JWT_EXPIRES_IN || '15m') as NonNullable<JwtSignOptions['expiresIn']>;

            @Module({
                imports: [
                    PassportModule,
                    JwtModule.register({
                        secret: process.env.JWT_SECRET,
                        signOptions: { expiresIn: jwtExpiresIn },
                    }),
                ],
                controllers: [AuthController${externalUsers ? ', ExternalAuthController' : ''}],
                providers: [TokenService, BackosVerifierService, InternalAuthService, JwtStrategy${externalUsers ? ', ExternalAuthService' : ''}],
            })
            export class AuthModule {}
        `,

        'src/users/users.module.ts': String.raw`
            import { Module } from '@nestjs/common';
            import { UsersService } from './users.service';
            import { UsersController } from './users.controller';

            @Module({ controllers: [UsersController], providers: [UsersService] })
            export class UsersModule {}
        `,

        'src/users/users.service.ts': buildUsersService(externalUsers, profileFields),
        'src/users/users.controller.ts': buildUsersController(profileFields.length > 0, externalUsers),
    };

    if (externalUsers) {
        Object.assign(files, externalFiles());
    }
    if (profileFields.length > 0) {
        files['src/users/dto/update-profile.dto.ts'] = buildUpdateProfileDto(profileFields);
    }

    await Promise.all(
        Object.entries(files).map(([relativePath, content]) =>
            fs.writeFile(path.join(projectPath, relativePath), content),
        ),
    );

    return [
        { name: 'AuthModule', importPath: './auth/auth.module' },
        { name: 'UsersModule', importPath: './users/users.module' },
    ];
}

/**
 * Files that only exist when external users are enabled: e-mail sign-up / login with a one-time code.
 * E-mails go through the generated `MailService` (Mailing service, required by Auth & User).
 */
function externalFiles(): Record<string, string> {
    return {

        'src/auth/dto/register-external.dto.ts': String.raw`
            import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
            import { Transform } from 'class-transformer';

            const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
            const normalizeEmail = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

            export class RegisterExternalDto {
                @Transform(normalizeEmail)
                @IsEmail()
                @MaxLength(254)
                email!: string;

                @Transform(trim)
                @IsString()
                @MinLength(1)
                @MaxLength(100)
                lastName!: string;

                @Transform(trim)
                @IsString()
                @MinLength(1)
                @MaxLength(100)
                firstName!: string;
            }
        `,

        'src/auth/dto/login-external.dto.ts': String.raw`
            import { IsEmail, MaxLength } from 'class-validator';
            import { Transform } from 'class-transformer';

            export class LoginExternalDto {
                @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
                @IsEmail()
                @MaxLength(254)
                email!: string;
            }
        `,

        'src/auth/dto/verify-otp.dto.ts': String.raw`
            import { IsEmail, IsString, Length, Matches, MaxLength } from 'class-validator';
            import { Transform } from 'class-transformer';

            export class VerifyOtpDto {
                @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
                @IsEmail()
                @MaxLength(254)
                email!: string;

                @Transform(({ value }) => (typeof value === 'string' ? value.replace(/\s+/g, '') : value))
                @IsString()
                @Length(6, 6)
                @Matches(/^[0-9]{6}$/)
                code!: string;
            }
        `,

        'src/auth/external-auth.service.ts': String.raw`
            import { HttpException, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
            import * as bcrypt from 'bcrypt';
            import * as crypto from 'crypto';
            import { PrismaService } from '../prisma/prisma.service';
            import { MailService } from '../mail/mail.service';
            import { TokenService } from './token.service';
            import { RegisterExternalDto } from './dto/register-external.dto';
            import { LoginExternalDto } from './dto/login-external.dto';
            import { VerifyOtpDto } from './dto/verify-otp.dto';

            const CODE_TTL_MS = 10 * 60_000;
            const RESEND_COOLDOWN_MS = 60_000;
            const MAX_CODES_PER_HOUR = 5;
            const MAX_ATTEMPTS = 5;
            const INVALID_CODE = 'Code invalide ou expiré.';

            // Identical whether or not the address is known, eligible or rate-limited - so these two
            // public endpoints cannot be used to find out which e-mail addresses have an account.
            const CODE_REQUESTED = { message: 'Si cette adresse est éligible, un code vient de lui être envoyé par e-mail.' };

            function escapeHtml(value: string): string {
                return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            }

            /**
             * External users - the visitors / customers of the product. No password: an e-mailed
             * one-time code proves ownership of the address, both to create the account and to log in.
             */
            @Injectable()
            export class ExternalAuthService {
                private readonly logger = new Logger(ExternalAuthService.name);

                constructor(
                    private readonly prisma: PrismaService,
                    private readonly mail: MailService,
                    private readonly tokens: TokenService,
                ) {}

                /** Step 1 of sign-up: last name + first name + e-mail. Nothing is created until the code is confirmed. */
                async register(dto: RegisterExternalDto) {
                    const email = this.normalizeEmail(dto.email);
                    void this.purgeExpired();

                    // Already registered: say nothing (see CODE_REQUESTED).
                    if (await this.prisma.appUser.findUnique({ where: { email } })) return CODE_REQUESTED;

                    const recent = await this.prisma.appSignupRequest.findMany({
                        where: { email, createdAt: { gt: new Date(Date.now() - 60 * 60_000) } },
                        orderBy: { createdAt: 'desc' },
                        select: { createdAt: true },
                    });
                    if (this.isRateLimited(recent.map((row) => row.createdAt))) return CODE_REQUESTED;

                    const code = this.generateCode();
                    await this.prisma.appSignupRequest.create({
                        data: {
                            email,
                            firstName: dto.firstName,
                            lastName: dto.lastName,
                            codeHash: await bcrypt.hash(code, 10),
                            expiresAt: new Date(Date.now() + CODE_TTL_MS),
                        },
                    });

                    await this.sendCode(email, dto.firstName, code, 'Confirmez votre adresse e-mail');
                    return CODE_REQUESTED;
                }

                /** Login step 1: e-mail only. A fresh code is sent if the account exists. */
                async requestLoginCode(dto: LoginExternalDto) {
                    const email = this.normalizeEmail(dto.email);
                    void this.purgeExpired();

                    const user = await this.prisma.appUser.findUnique({ where: { email } });
                    if (!user || !user.isActive) return CODE_REQUESTED;

                    const recent = await this.prisma.appOtpCode.findMany({
                        where: { userId: user.id, createdAt: { gt: new Date(Date.now() - 60 * 60_000) } },
                        orderBy: { createdAt: 'desc' },
                        select: { createdAt: true },
                    });
                    if (this.isRateLimited(recent.map((row) => row.createdAt))) return CODE_REQUESTED;

                    const code = this.generateCode();
                    await this.prisma.appOtpCode.create({
                        data: {
                            userId: user.id,
                            codeHash: await bcrypt.hash(code, 10),
                            expiresAt: new Date(Date.now() + CODE_TTL_MS),
                        },
                    });

                    await this.sendCode(email, user.firstName, code, 'Votre code de connexion');
                    return CODE_REQUESTED;
                }

                /**
                 * Second step, for BOTH flows: e-mail + code. For an address that already has an account
                 * this logs in; otherwise it completes the pending sign-up (the account is created now).
                 */
                async verify(dto: VerifyOtpDto) {
                    const email = this.normalizeEmail(dto.email);
                    const user = await this.prisma.appUser.findUnique({ where: { email } });
                    return user ? this.verifyLoginCode(user, dto.code) : this.verifySignupCode(email, dto.code);
                }

                private async verifyLoginCode(user: { id: string; email: string; isActive: boolean }, code: string) {
                    if (!user.isActive) throw new UnauthorizedException(INVALID_CODE);

                    const otp = await this.prisma.appOtpCode.findFirst({
                        where: { userId: user.id, consumedAt: null, expiresAt: { gt: new Date() } },
                        orderBy: { createdAt: 'desc' },
                    });
                    if (!otp || otp.attempts >= MAX_ATTEMPTS) throw new UnauthorizedException(INVALID_CODE);

                    if (!(await bcrypt.compare(code, otp.codeHash))) {
                        await this.prisma.appOtpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
                        throw new UnauthorizedException(INVALID_CODE);
                    }

                    // Single use, claimed atomically.
                    const claimed = await this.prisma.appOtpCode.updateMany({
                        where: { id: otp.id, consumedAt: null },
                        data: { consumedAt: new Date() },
                    });
                    if (claimed.count !== 1) throw new UnauthorizedException(INVALID_CODE);

                    return this.tokens.issue({ kind: 'external', id: user.id, email: user.email });
                }

                private async verifySignupCode(email: string, code: string) {
                    const request = await this.prisma.appSignupRequest.findFirst({
                        where: { email, consumedAt: null, expiresAt: { gt: new Date() } },
                        orderBy: { createdAt: 'desc' },
                    });
                    if (!request || request.attempts >= MAX_ATTEMPTS) throw new UnauthorizedException(INVALID_CODE);

                    if (!(await bcrypt.compare(code, request.codeHash))) {
                        await this.prisma.appSignupRequest.update({ where: { id: request.id }, data: { attempts: { increment: 1 } } });
                        throw new UnauthorizedException(INVALID_CODE);
                    }

                    try {
                        // Claim the request and create the account together: either both happen or neither.
                        const user = await this.prisma.$transaction(async (tx) => {
                            const claimed = await tx.appSignupRequest.updateMany({
                                where: { id: request.id, consumedAt: null },
                                data: { consumedAt: new Date() },
                            });
                            if (claimed.count !== 1) throw new UnauthorizedException(INVALID_CODE);

                            return tx.appUser.create({
                                data: { email, firstName: request.firstName, lastName: request.lastName },
                            });
                        });
                        return await this.tokens.issue({ kind: 'external', id: user.id, email: user.email });
                    } catch (error) {
                        if (error instanceof HttpException) throw error;
                        // Most likely a concurrent sign-up for the same address (unique e-mail).
                        this.logger.warn('Sign-up could not be completed: ' + (error instanceof Error ? error.message : String(error)));
                        throw new UnauthorizedException(INVALID_CODE);
                    }
                }

                private isRateLimited(recentCreatedAt: Date[]): boolean {
                    if (recentCreatedAt.length >= MAX_CODES_PER_HOUR) return true;
                    return recentCreatedAt.length > 0 && Date.now() - recentCreatedAt[0].getTime() < RESEND_COOLDOWN_MS;
                }

                private async sendCode(email: string, firstName: string, code: string, subject: string) {
                    const text = 'Bonjour ' + firstName + ', votre code est : ' + code + ' (valide 10 minutes). Si vous n\'êtes pas à l\'origine de cette demande, ignorez ce message.';
                    const html =
                        '<p>Bonjour ' + escapeHtml(firstName) + ',</p>' +
                        '<p>Votre code : <strong>' + code + '</strong></p>' +
                        '<p>Valide 10 minutes. Si vous n\'êtes pas à l\'origine de cette demande, ignorez ce message.</p>';
                    try {
                        await this.mail.send(email, subject, text, html);
                    } catch (error) {
                        this.logger.error('Could not send the code e-mail: ' + (error instanceof Error ? error.message : String(error)));
                        throw new ServiceUnavailableException('Impossible d\'envoyer l\'e-mail pour le moment, merci de réessayer.');
                    }
                }

                /** Uniformly random 6-digit code (leading zeros allowed). */
                private generateCode(): string {
                    return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
                }

                private normalizeEmail(email: string): string {
                    return email.trim().toLowerCase();
                }

                /** Housekeeping: drop codes / sign-up requests that expired more than a day ago. */
                private async purgeExpired() {
                    const cutoff = new Date(Date.now() - 24 * 60 * 60_000);
                    try {
                        await this.prisma.appSignupRequest.deleteMany({ where: { expiresAt: { lt: cutoff } } });
                        await this.prisma.appOtpCode.deleteMany({ where: { expiresAt: { lt: cutoff } } });
                    } catch (error) {
                        this.logger.warn('Cleanup of expired codes failed: ' + (error instanceof Error ? error.message : String(error)));
                    }
                }
            }
        `,

        'src/auth/external-auth.controller.ts': String.raw`
            import { Body, Controller, HttpCode, Post } from '@nestjs/common';
            import { ApiTags } from '@nestjs/swagger';
            import { ExternalAuthService } from './external-auth.service';
            import { RegisterExternalDto } from './dto/register-external.dto';
            import { LoginExternalDto } from './dto/login-external.dto';
            import { VerifyOtpDto } from './dto/verify-otp.dto';
            import { Public } from '../common/decorators/public.decorator';

            @ApiTags('Auth (external users)')
            @Controller('auth/external')
            export class ExternalAuthController {
                constructor(private readonly externalAuth: ExternalAuthService) {}

                /** Sign-up, step 1: last name, first name, e-mail. A code is sent to that address. */
                @Public()
                @Post('register')
                @HttpCode(200)
                register(@Body() dto: RegisterExternalDto) {
                    return this.externalAuth.register(dto);
                }

                /** Login, step 1: e-mail. A fresh code is sent to that address. */
                @Public()
                @Post('login')
                @HttpCode(200)
                login(@Body() dto: LoginExternalDto) {
                    return this.externalAuth.requestLoginCode(dto);
                }

                /** Step 2 of sign-up AND of login: e-mail + the code. Returns the tokens. */
                @Public()
                @Post('verify')
                @HttpCode(200)
                verify(@Body() dto: VerifyOtpDto) {
                    return this.externalAuth.verify(dto);
                }
            }
        `,
    };
}

/** DTO of `PATCH /users/me/profile`: every profile field, all optional (a profile is filled in progressively). */
function buildUpdateProfileDto(profileFields: ReturnType<typeof readProfileFields>): string {
    const fields = profileFields.map((field) => ({ column: field.column, type: field.type, required: false, isArray: field.isArray }));
    const imports = Array.from(collectFieldValidatorImports(fields)).sort().join(', ');

    return `
            import { ${imports} } from 'class-validator';

            export class UpdateProfileDto {
                ${buildDtoFieldsSource(fields, true)}
            }
        `;
}

function buildUsersController(hasProfile: boolean, externalUsers: boolean): string {
    return `
            import { Controller, Get${hasProfile ? ', Patch, Body' : ''}, Query, UseGuards } from '@nestjs/common';
            import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
            import { UsersService } from './users.service';
            ${hasProfile ? "import { UpdateProfileDto } from './dto/update-profile.dto';" : ''}
            import { AuthenticatedUser } from '../auth/auth.types';
            import { CurrentUser } from '../common/decorators/current-user.decorator';
            import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
            ${externalUsers ? "import { InternalOnlyGuard } from '../common/guards/internal-only.guard';" : ''}

            @ApiTags('Users')
            @ApiBearerAuth('access-token')
            @UseGuards(JwtAuthGuard)
            @Controller('users')
            export class UsersController {
                constructor(private readonly usersService: UsersService) {}

                /** The signed-in account: an internal account, or an external user with their profile. */
                @Get('me')
                getMe(@CurrentUser() user: AuthenticatedUser) {
                    return this.usersService.getMe(user);
                }
                ${hasProfile ? `
                /** External users only: fill in / update the profile (any subset of its fields). */
                @Patch('me/profile')
                updateProfile(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateProfileDto) {
                    return this.usersService.updateProfile(user, dto);
                }
                ` : ''}
                ${externalUsers ? `
                /** Every external user (visitor / customer) of this platform - the "Users" tab's external list. Internal accounts only. */
                @UseGuards(InternalOnlyGuard)
                @Get('external')
                listExternal(@Query('page') page?: string, @Query('limit') limit?: string) {
                    return this.usersService.listExternal(Number(page) || 1, Number(limit) || 25);
                }
                ` : ''}
            }
        `;
}

function buildUsersService(externalUsers: boolean, profileFields: ReturnType<typeof readProfileFields>): string {
    const hasProfile = profileFields.length > 0;
    const names = profileFields.map((field) => toCamelCase(field.column));

    const q = (value: string) => JSON.stringify(value);
    const profileSelect = `{ ${names.map((name) => `${name}: true`).join(', ')} }`;
    const emptyProfile = `{ ${profileFields.map((field) => `${toCamelCase(field.column)}: ${field.isArray ? '[]' : 'null'}`).join(', ')} }`;
    const requiredNames = profileFields.filter((field) => field.required).map((field) => toCamelCase(field.column));
    const dateNames = profileFields
        .filter((field) => FIELD_TYPE_VALIDATORS[field.type as keyof typeof FIELD_TYPE_VALIDATORS].isDateField)
        .map((field) => toCamelCase(field.column));
    const arrayNames = profileFields.filter((field) => field.isArray).map((field) => toCamelCase(field.column));

    const externalMethods = !externalUsers
        ? ''
        : `
                async listExternal(page: number, limit: number) {
                    const safePage = Math.max(1, page);
                    const safeLimit = Math.min(100, Math.max(1, limit));
                    const [items, total] = await Promise.all([
                        this.prisma.appUser.findMany({
                            select: { id: true, email: true, firstName: true, lastName: true, isActive: true, createdAt: true },
                            orderBy: { createdAt: 'desc' },
                            skip: (safePage - 1) * safeLimit,
                            take: safeLimit,
                        }),
                        this.prisma.appUser.count(),
                    ]);
                    return { items, total, page: safePage, limit: safeLimit };
                }

                private async getExternalMe(userId: string) {
                    const user = await this.prisma.appUser.findUnique({
                        where: { id: userId },
                        select: {
                            id: true, email: true, firstName: true, lastName: true, isActive: true, createdAt: true,
                            ${hasProfile ? `profile: { select: PROFILE_SELECT },` : ''}
                        },
                    });
                    if (!user) throw new NotFoundException('Utilisateur introuvable.');
                    ${hasProfile ? `
                    const { profile, ...account } = user;
                    const values: Record<string, unknown> = { ...EMPTY_PROFILE, ...(profile ?? {}) };
                    const missingProfileFields = REQUIRED_PROFILE_FIELDS.filter((name) => this.isEmpty(values[name]));
                    return { type: 'external', ...account, profile: values, profileComplete: missingProfileFields.length === 0, missingProfileFields };
                    ` : `
                    return { type: 'external', ...user };
                    `}
                }
                ${hasProfile ? `
                async updateProfile(user: AuthenticatedUser, dto: UpdateProfileDto) {
                    if (user.type !== 'external') throw new ForbiddenException('Seuls les utilisateurs externes ont un profil.');

                    const data = this.toProfileData(dto);
                    await this.prisma.appUserProfile.upsert({
                        where: { userId: user.userId },
                        update: data as any,
                        create: { userId: user.userId, ...data } as any,
                    });
                    return this.getExternalMe(user.userId);
                }

                /** ISO strings become Dates; an explicit null on a list clears it (Prisma lists cannot be null). */
                private toProfileData(dto: UpdateProfileDto): Record<string, unknown> {
                    const data: Record<string, unknown> = { ...dto };
                    for (const name of ARRAY_PROFILE_FIELDS) {
                        if (data[name] === null) data[name] = [];
                    }
                    for (const name of DATE_PROFILE_FIELDS) {
                        const value = data[name];
                        if (Array.isArray(value)) data[name] = value.map((item) => new Date(item as string));
                        else if (typeof value === 'string') data[name] = new Date(value);
                    }
                    return data;
                }

                private isEmpty(value: unknown): boolean {
                    return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
                }
                ` : ''}
        `;

    return `
            import { ${externalUsers && hasProfile ? 'ForbiddenException, ' : ''}Injectable, NotFoundException } from '@nestjs/common';
            import { PrismaService } from '../prisma/prisma.service';
            import { AuthenticatedUser } from '../auth/auth.types';
            ${hasProfile ? "import { UpdateProfileDto } from './dto/update-profile.dto';" : ''}
            ${hasProfile ? `
            // Generated from the profile fields defined in BackOS (Auth & User service).
            const PROFILE_SELECT = ${profileSelect} as const;
            const EMPTY_PROFILE: Record<string, unknown> = ${emptyProfile};
            const REQUIRED_PROFILE_FIELDS: string[] = ${JSON.stringify(requiredNames).replace(/"/g, "'")};
            const DATE_PROFILE_FIELDS: string[] = ${JSON.stringify(dateNames).replace(/"/g, "'")};
            const ARRAY_PROFILE_FIELDS: string[] = ${JSON.stringify(arrayNames).replace(/"/g, "'")};
            ` : ''}
            @Injectable()
            export class UsersService {
                constructor(private readonly prisma: PrismaService) {}

                async getMe(user: AuthenticatedUser) {
                    if (user.type === 'internal') {
                        const account = await this.prisma.appInternalAccount.findUnique({
                            where: { id: user.userId },
                            select: { id: true, username: true, isActive: true, createdAt: true },
                        });
                        if (!account) throw new NotFoundException('Compte introuvable.');
                        return { type: 'internal', ...account };
                    }
                    ${externalUsers ? 'return this.getExternalMe(user.userId);' : "throw new NotFoundException('Compte introuvable.');"}
                }
                ${externalMethods}
            }
        `;
}
