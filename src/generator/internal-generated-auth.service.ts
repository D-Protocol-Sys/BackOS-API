import { PlatformAccessService } from '../platforms/platform-access.service';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UserStatus } from '@prismamodels/enums';
import { createHash, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { AuditContext } from '../audit/audit-log.service';
import { PlatformServicesService } from './platform-services.service';

/**
 * BackOS side of the "internal login" of a generated backend's Auth & User service.
 *
 * A generated backend has no idea what anyone's authenticator secret is - only BackOS does. When
 * a member of the team logs in there with their BackOS username + current code, the generated
 * backend forwards the check here. Every request is authenticated with the platform's own
 * `internalAuthKey` (generated when Auth & User was enabled, stored encrypted, and handed to the
 * generated backend through its `.env`), so only THAT platform's backend can ask - and only about
 * people who actually belong to THAT platform (its owner or one of its members).
 *
 * Every refusal is the same generic 401: a caller learns nothing about which platforms, users or
 * memberships exist.
 */
@Injectable()
export class InternalGeneratedAuthService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly authService: AuthService,
        private readonly platformServices: PlatformServicesService,
        private readonly access: PlatformAccessService,
    ) {}

    /** Full check: the platform's key is right, the user belongs to it, and their TOTP code is valid. */
    async verify(
        platformId: string | undefined,
        presentedKey: string | undefined,
        userId: string,
        totpCode: string,
        context: AuditContext,
    ) {
        const platform = await this.authenticateGeneratedBackend(platformId, presentedKey);
        await this.assertBelongsToPlatform(platform.id, userId);
        return this.authService.verifyTotpForGeneratedBackend(userId, totpCode, platform.id, context);
    }

    /** Session renewal: still an active BackOS user AND still an owner / member of the platform? */
    async sessionCheck(platformId: string | undefined, presentedKey: string | undefined, userId: string) {
        const platform = await this.authenticateGeneratedBackend(platformId, presentedKey);
        await this.assertBelongsToPlatform(platform.id, userId);
        return this.authService.assertActiveUserForGeneratedBackend(userId);
    }

    /**
     * Resolves a BackOS username to a user id, but only when that person currently holds an internal
     * account on THIS platform (owner, ADMIN, or a role with a `data.*` permission) - used when a generated backend grants someone internal (admin)
     * access on itself, so it never has to trust a username it cannot verify against BackOS's own
     * membership records. Returns `null` for an unknown username or a real BackOS user who simply
     * isn't part of this platform - both are ordinary, expected outcomes here, not failures.
     */
    async lookupMember(
        platformId: string | undefined,
        presentedKey: string | undefined,
        username: string,
    ): Promise<{ userId: string; username: string } | null> {
        const platform = await this.authenticateGeneratedBackend(platformId, presentedKey);

        const user = await this.prisma.user.findFirst({
            where: { username: { equals: username, mode: 'insensitive' }, status: UserStatus.ACTIVE },
            select: { id: true, username: true },
        });
        if (!user) return null;

        const belongs = await this.belongsToPlatform(platform.id, user.id);
        return belongs ? { userId: user.id, username: user.username } : null;
    }

    /**
     * The live list of people who hold an internal account on this platform's generated backend
     * (owner + ADMINs + holders of a role with a `data.*` permission). Pulled by the generated
     * backend at start-up and every time BackOS tells it a role changed (`InternalAccountsSyncService`),
     * so accounts appear - or get revoked - without any restart or regeneration.
     */
    async listInternalAccounts(platformId: string | undefined, presentedKey: string | undefined) {
        const platform = await this.authenticateGeneratedBackend(platformId, presentedKey);
        return this.access.listInternalAccounts(platform.id);
    }

    /**
     * Proves the caller is the generated backend of `platformId`: compares the presented key with
     * the platform's stored `internalAuthKey`, in constant time.
     */
    private async authenticateGeneratedBackend(platformId: string | undefined, presentedKey: string | undefined) {
        if (!platformId || !presentedKey) throw new UnauthorizedException('Invalid credentials.');

        const config = await this.platformServices.getFullDecryptedConfig(platformId, 'auth-user').catch(() => null);
        const expectedKey = config?.internalAuthKey;
        if (typeof expectedKey !== 'string' || expectedKey.length === 0) {
            throw new UnauthorizedException('Invalid credentials.');
        }

        // Hash both sides so the buffers have equal length and timingSafeEqual can be used safely.
        const expected = createHash('sha256').update(expectedKey).digest();
        const presented = createHash('sha256').update(presentedKey).digest();
        if (!timingSafeEqual(expected, presented)) throw new UnauthorizedException('Invalid credentials.');

        return { id: platformId };
    }

    /** Only the owner, an ADMIN, or a member whose role has a `data.*` permission may hold an internal account on its backend. */
    private async assertBelongsToPlatform(platformId: string, userId: string): Promise<void> {
        if (!(await this.belongsToPlatform(platformId, userId))) {
            throw new UnauthorizedException('Invalid credentials.');
        }
    }

    private async belongsToPlatform(platformId: string, userId: string): Promise<boolean> {
        const platform = await this.prisma.platform.findUnique({
            where: { id: platformId },
            select: { id: true, ownerId: true },
        });
        if (!platform) return false;
        return this.access.hasInternalAccess(userId, platform);
    }
}
