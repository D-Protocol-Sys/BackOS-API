import { Injectable, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomInt, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { AuditLogService, AuditContext } from '../audit/audit-log.service';
import { MfaService } from '../common/services/mfa.service';
import { RoleHierarchyService } from '../common/services/role-hierarchy.service';
import { ValidateInvitationDto } from './dto/validate-invitation.dto';
import { ConsumeInvitationDto } from './dto/consume-invitation.dto';
import { ConfirmMfaDto } from './dto/confirm-mfa.dto';
import { LoginDto } from './dto/login.dto';
import { RecoveryLoginDto } from './dto/recovery-login.dto';
import { generateSecureToken, hashToken } from '../common/utils/token.util';
import { buildInvitationEmail } from '../email/templates/invitation-email.template';
import { RecoveryCodeService } from '../common/utils/recovery-code.service';
import { AUDIT_ACTIONS } from '../common/constants/audit-actions';
import { AUDIT_TARGETS } from '../common/constants/audit-target.constant';
import { MfaStatus, UserStatus } from '@prismamodels/enums';

@Injectable()
export class AuthService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly jwtService: JwtService,
        private readonly configService: ConfigService,
        private readonly emailService: EmailService,
        private readonly auditLog: AuditLogService,
        private readonly recoveryCode: RecoveryCodeService,
        private readonly mfaService: MfaService,
        private readonly roleHierarchy: RoleHierarchyService,
    ) {}

    // ---- Invitation ----

    /**
     * Generates and sends an account activation invitation for a specific user.
     * * Process Flow:
     * 1. Fetches and validates user existence.
     * 2. Generates a secure random activation token and a 6-digit OTP code.
     * 3. Stores hashed versions of the token and code in the database with an expiration threshold.
     * 4. Constructs a frontend activation link and dispatches the invitation email.
     * 5. Records an audit log entry for security tracking.
     * * @param userId - Unique identifier of the target user to invite.
     * @returns Object containing the raw activation link and raw OTP code.
     * @throws PrismaClientKnownRequestError if the user ID does not exist.
     */
    async createInvitationForUser(userId: string, actorId: string) {
        // 1. Ensure target user exists before proceeding
        const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
        const actor = await this.prisma.user.findUniqueOrThrow({ where: { id: actorId } });

        // 2. Generate raw secrets and calculate cryptographic hashes
        const rawToken = generateSecureToken();
        const code = randomInt(100000, 1000000).toString();
        const tokenHash = hashToken(rawToken);

        const saltRounds = this.configService.get<number>('totp.saltRounds', 12);
        const codeHash = await bcrypt.hash(code, saltRounds);

        // CONFIG FIX (ARCH-003): the key used to be 'mfa.invitationExpiresInHours', a namespace
        // that does not exist, so INVITATION_EXPIRES_IN_HOURS was silently ignored.
        const INVITATION_EXPIRES_IN_HOURS = this.configService.get<number>('totp.invitationExpiresInHours', 48);

        // Only the latest invitation of a user stays usable.
        await this.prisma.invitation.updateMany({
            where: { userId: user.id, used: false },
            data: { used: true, usedAt: new Date() },
        });
        const expiresAt = new Date(Date.now() + INVITATION_EXPIRES_IN_HOURS * 60 * 60 * 1000);

        // 3. Persist hashed invitation credentials and expiration date
        const invitation = await this.prisma.invitation.create({
            data: {
                userId: user.id,
                tokenHash,
                codeHash,
                expiresAt,
            },
        });

        await this.auditLog.log({
            action: AUDIT_ACTIONS.INVITATION_CREATED,
            actorId: actor.id,
            targetType: AUDIT_TARGETS.INVITATION,
            targetId: invitation.id,
            metadata: {
                invitedUserId: invitation.userId,
                invitedUserWorkEmail: user.workEmail,
                expiresAt: expiresAt,
            },
        });

        // 4. Construct frontend magic link and prepare email content
        const frontendUrl = this.configService.get<string>('app.frontendUrl');
        const activationLink = `${frontendUrl}/activate?token=${rawToken}`;

        const { subject, text, html } = buildInvitationEmail(
            activationLink,
            code,
            user.firstName,
            user.username,
            user.workEmail,
            INVITATION_EXPIRES_IN_HOURS,
        );

        // 5. Dispatch notification email to user's personal address
        try {
            await this.emailService.sendMail(user.personalEmail!, subject, text, html);
            await this.auditLog.log({
                action: AUDIT_ACTIONS.INVITATION_SENT,
                actorId: actor.id,
                targetType: AUDIT_TARGETS.INVITATION,
                targetId: invitation.id,
                metadata: { destination: user.personalEmail },
            });
        } catch (error) {
            await this.auditLog.log({
                action: AUDIT_ACTIONS.INVITATION_FAILED,
                actorId: actor.id,
                targetType: AUDIT_TARGETS.INVITATION,
                targetId: invitation.id,
                metadata: {
                    reason: error instanceof Error ? error.message : 'Unknown email error',
                },
            });
            throw error;
        }

        // Return unhashed credentials to the caller
        return { activationLink, rawCode: code };
    }

    /**
     * Validates an invitation token provided by a user during account setup.
     * * Used primarily by the frontend activation page to verify whether a token is valid,
     * active, and not expired before presenting the user with the setup form.
     * * @param dto - Data Transfer Object containing the raw token query parameter.
     * @returns Object indicating validity status (`valid: true`) and the user's personal email.
     * @throws NotFoundException / UnauthorizedException if the token is invalid or expired.
     */
    async validateInvitationToken(dto: ValidateInvitationDto) {
        // 1. Fetch invitation record and verify expiration & status in database
        const invitation = await this.findValidInvitationByToken(dto.token);

        // 2. Return success status along with basic identity info for UI pre-filling
        return {
            valid: true,
            email: invitation.user.workEmail,
        };
    }

    /**
     * Consumes an activation invitation, verifies the OTP code, and initiates the TOTP/MFA setup flow.
     * * Process Flow:
     * 1. Retrieves and validates the active invitation token.
     * 2. Checks if maximum allowed validation attempts have been exceeded.
     * 3. Verifies the user-provided code against the stored bcrypt hash (increments attempts on failure).
     * 4. Marks the invitation as consumed (`used: true`).
     * 5. Generates encrypted TOTP secret, provisioning URI, and QR Code payload via MfaService.
     * 6. Updates user account status to `ACTIVATING`.
     * 7. Records a security audit log event with context details.
     * * @param dto - Data Transfer Object containing raw token and user-entered OTP code.
     * @param context - Request audit details containing IP address and User-Agent header.
     * @returns Object containing QR code data URL, plain secret key for manual entry, and OTP Auth URI.
     * @throws UnauthorizedException if maximum attempts are exceeded or the code is invalid.
     */
    async consumeInvitation(dto: ConsumeInvitationDto, context: AuditContext) {
        // 1. Retrieve active invitation associated with the provided token
        const invitation = await this.findValidInvitationByToken(dto.token);

        // CONFIG FIX (ARCH-003): was 'totp.maxAttempts', which does not exist.
        const maxAttempts = this.configService.get<number>('totp.invitationMaxAttempts', 5);

        // CONCURRENCY FIX (SEC-029): an attempt is reserved atomically BEFORE the bcrypt
        // comparison. Parallel requests used to all read `attempts < max` and all get a guess.
        const reserved = await this.prisma.invitation.updateMany({
            where: { id: invitation.id, used: false, attempts: { lt: maxAttempts } },
            data: { attempts: { increment: 1 } },
        });

        if (reserved.count === 0) {
            await this.auditLog.log({
                action: AUDIT_ACTIONS.INVITATION_LOCKED,
                actorId: invitation.userId,
                targetType: AUDIT_TARGETS.INVITATION,
                targetId: invitation.id,
                metadata: { attempts: invitation.attempts, maxAttempts },
                context,
            });

            throw new UnauthorizedException('Too many failed attempts. Invitation has been invalidated.');
        }

        const isValidCode = await bcrypt.compare(dto.code, invitation.codeHash);
        if (!isValidCode) {
            throw new UnauthorizedException('Invalid verification code.');
        }

        // Single use, enforced atomically (two concurrent valid submissions cannot both succeed).
        const consumed = await this.prisma.invitation.updateMany({
            where: { id: invitation.id, used: false },
            data: { used: true, usedAt: new Date() },
        });
        if (consumed.count === 0) {
            throw new UnauthorizedException('This invitation has already been used.');
        }

        await this.auditLog.log({
            action: AUDIT_ACTIONS.INVITATION_USED,
            actorId: invitation.userId,
            targetType: AUDIT_TARGETS.INVITATION,
            targetId: invitation.id,
            // PRIVACY FIX (SEC-029): used to store the whole user row in the audit metadata.
            metadata: { invitedUserId: invitation.userId },
            context,
        });

        // 5. Generate TOTP enrollment payloads via MfaService
        const enrollment = await this.mfaService.generateEnrollment(invitation.user.workEmail);

        await this.prisma.userMfa.upsert({
            where: { userId: invitation.userId },
            update: {
                secretEncrypted: enrollment.encryptedSecret,
                status: 'PENDING',
            },
            create: {
                userId: invitation.userId,
                secretEncrypted: enrollment.encryptedSecret,
                status: 'PENDING',
            },
        });

        // 6. Transition user lifecycle status to ACTIVATING
        await this.prisma.user.update({
            where: { id: invitation.userId },
            data: { status: 'ACTIVATING' },
        });

        return {
            qrCodeDataUrl: enrollment.qrCode,
            manualEntryKey: enrollment.secret,
            otpauthUri: enrollment.uri,
        };
    }

    // ---- Activation MFA ----

    /**
     * Confirms and activates Time-based One-Time Password (TOTP) Multi-Factor Authentication.
     * * Process Flow:
     * 1. Verifies user existence and ensures account is in `ACTIVATING` lifecycle state.
     * 2. Fetches user's pending MFA configuration record.
     * 3. Validates provided 6-digit TOTP code using MfaService.
     * 4. Transitions both User and UserMfa records to `ACTIVE` state.
     * 5. Generates 8 single-use recovery codes, hashes them, and persists them to the database.
     * 6. Records a successful `mfa.activated` security audit log event.
     * 7. Issues access & refresh JWT tokens and returns them alongside plaintext recovery codes.
     * * @param dto - Data Transfer Object containing user's work email and 6-digit TOTP verification code.
     * @param context - Request context containing client IP and User-Agent headers.
     * @returns Object containing JWT auth tokens and plaintext recovery codes (shown ONCE to the user).
     * @throws UnauthorizedException if user status is invalid, MFA is not pending, or TOTP code is invalid.
     */
    async confirmMfa(dto: ConfirmMfaDto, context: AuditContext) {
        // 1. Fetch user by email and verify account is in ACTIVATING state
        const user = await this.prisma.user.findUnique({ where: { workEmail: dto.email } });
        if (!user || user.status !== UserStatus.ACTIVATING) {
            throw new UnauthorizedException('Account activation is not available for this user.');
        }

        // 2. Fetch MFA configuration and ensure status is PENDING
        const mfa = await this.prisma.userMfa.findUnique({ where: { userId: user.id } });
        if (!mfa || mfa.status !== MfaStatus.PENDING) {
            throw new UnauthorizedException('No pending MFA setup found for this account.');
        }

        // SECURITY FIX (SEC-009): confirmation had no attempt limit, allowing unlimited guesses
        // while the account is ACTIVATING. It now shares the login lockout policy.
        if (user.lockedUntil && user.lockedUntil > new Date()) {
            throw new UnauthorizedException('Invalid verification code.');
        }

        // 3. Verify TOTP code via MfaService (single use)
        const isValid = await this.verifyTotpOnce(user.id, mfa.secretEncrypted, dto.totpCode);
        if (!isValid) {
            await this.registerFailedLoginAttempt(user.id, context);
            throw new UnauthorizedException('Invalid verification code.');
        }

        // 4. Update MFA and User statuses to ACTIVE
        await this.prisma.userMfa.update({
            where: { userId: user.id },
            data: { status: MfaStatus.ACTIVE },
        });

        await this.prisma.user.update({
            where: { id: user.id },
            data: { status: UserStatus.ACTIVE },
        });

        // 5. Generate 8 plain recovery codes and store their hashed versions
        const recoveryCodes = this.recoveryCode.generate();
        await this.prisma.recoveryCode.createMany({
            data: recoveryCodes.map((code) => ({
                userId: user.id,
                codeHash: this.recoveryCode.hashRecoveryCode(code),
            })),
        });

        // 6. Log successful MFA activation audit event
        await this.auditLog.log({
            action: AUDIT_ACTIONS.MFA_ENABLED,
            actorId: user.id,
            targetType: AUDIT_TARGETS.USER,
            targetId: user.id,
            context,
        });

        // 7. Issue authentication tokens and return payload
        const tokens = await this.issueTokens(user.id, user.workEmail);
        return { ...tokens, recoveryCodes };
    }

    // ---- Login ----

    /**
     * Authenticates a user using either their work email or username alongside a 2FA/TOTP code.
     * * Process Flow:
     * 1. Searches for user by work email OR username, verifying account status is `ACTIVE`.
     * 2. Fetches associated MFA configuration and checks that MFA status is `ACTIVE`.
     * 3. Validates provided 6-digit TOTP code via MfaService (logs audit event on failure).
     * 4. Records a successful `login.success` security audit log event.
     * 5. Generates and returns a fresh pair of Access and Refresh JWT tokens.
     * * @param dto - Data Transfer Object containing identifier (email or username) and TOTP code.
     * @param context - Request context containing client IP address and User-Agent headers.
     * @returns Object containing newly issued access and refresh tokens.
     * @throws UnauthorizedException with generic error message to prevent account enumeration.
     */
    /**
     * Authenticates a user via login identifier (work email or username) plus a valid TOTP code.
     *
     * SECURITY FIX - per-account brute-force lockout: the previous implementation had no
     * failed-attempt tracking at all for this endpoint, relying solely on the global,
     * per-IP request throttle (shared with the entire API) to slow down attackers. That is
     * not sufficient on its own against a distributed attacker rotating source IPs, or
     * against an attacker with a very large window to guess a 6-digit TOTP code. We now track
     * `failedLoginAttempts` / `lockedUntil` on the `User` record itself (independent of source
     * IP), matching the same defense-in-depth pattern already used for invitation consumption
     * (`Invitation.attempts` / `maxAttempts`).
     *
     * NOTE: this requires two additional columns on the `User` model - see
     * `failedLoginAttempts Int @default(0)` and `lockedUntil DateTime?` in the accompanying
     * schema migration notes.
     */
    async login(dto: LoginDto, context: AuditContext) {
        // 1. Fetch user by work email OR username where status is ACTIVE
        const user = await this.prisma.user.findFirst({
            where: {
                OR: [{ workEmail: dto.loginIdentifier }, { username: dto.loginIdentifier }],
            },
        });

        if (!user || user.status !== UserStatus.ACTIVE) {
            throw new UnauthorizedException('Invalid credentials.');
        }

        // 2. Reject outright if the account is currently locked out from prior failed attempts.
        // We deliberately return the same generic message as an invalid credential, so an
        // attacker cannot use response differences to enumerate which accounts are locked.
        if (user.lockedUntil && user.lockedUntil > new Date()) {
            throw new UnauthorizedException('Invalid credentials.');
        }

        // 3. Fetch MFA configuration and ensure MFA is fully active
        const mfa = await this.prisma.userMfa.findUnique({ where: { userId: user.id } });
        if (!mfa || mfa.status !== MfaStatus.ACTIVE) {
            throw new UnauthorizedException('Invalid credentials.');
        }

        // 4. Verify TOTP code via MfaService (a code is accepted only once - SEC-009)
        const isValid = await this.verifyTotpOnce(user.id, mfa.secretEncrypted, dto.totpCode);
        if (!isValid) {
            await this.registerFailedLoginAttempt(user.id, context);
            throw new UnauthorizedException('Invalid credentials.');
        }

        // 5. Successful login: clear any prior failed-attempt counter.
        await this.prisma.user.update({
            where: { id: user.id },
            data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
        });

        // 6. Record successful login event in security audit log
        await this.auditLog.log({
            action: AUDIT_ACTIONS.LOGIN,
            actorId: user.id,
            targetType: AUDIT_TARGETS.USER,
            targetId: user.id,
            context,
        });

        // 7. Issue and return authentication JWT tokens
        return this.issueTokens(user.id, user.workEmail);
    }

    /**
     * Increments the failed-login counter for a user and, once the configured threshold is
     * reached, locks the account for a fixed cool-down window.
     *
     * Kept as its own method (rather than inlined in `login()`) so the lockout policy is easy
     * to locate, audit, and unit-test in isolation.
     *
     * @param userId - The user whose failed attempt is being recorded.
     * @param currentAttempts - The attempt counter value already on the user record, prior to
     *   this failure, so we can decide here whether the new count crosses the lockout threshold.
     * @param context - Audit metadata (IP address, user agent) for the security audit trail.
     */
    private async registerFailedLoginAttempt(userId: string, context: AuditContext): Promise<void> {
        const maxAttempts = this.configService.get<number>('security.loginLockout.maxAttempts') ?? 5;
        const lockoutMinutes = this.configService.get<number>('security.loginLockout.lockoutMinutes') ?? 15;

        // CONCURRENCY FIX (SEC-008): the counter used to be written as an absolute value read
        // earlier in the request, so N parallel wrong guesses all wrote "1" and the lockout never
        // triggered. The increment and the lock decision now happen in ONE atomic UPDATE.
        const rows = await this.prisma.$queryRaw<{ attempts: number; locked: boolean }[]>`
            UPDATE users
            SET "failedLoginAttempts" = CASE WHEN "failedLoginAttempts" + 1 >= ${maxAttempts} THEN 0 ELSE "failedLoginAttempts" + 1 END,
                "lockedUntil" = CASE WHEN "failedLoginAttempts" + 1 >= ${maxAttempts}
                                     THEN now() + (${lockoutMinutes} * interval '1 minute')
                                     ELSE "lockedUntil" END
            WHERE id = ${userId}
            RETURNING "failedLoginAttempts" AS attempts,
                      ("lockedUntil" IS NOT NULL AND "lockedUntil" > now()) AS locked`;

        const shouldLock = rows[0]?.locked === true && rows[0]?.attempts === 0;

        await this.auditLog.log({
            action: shouldLock ? AUDIT_ACTIONS.LOGIN_LOCKED : AUDIT_ACTIONS.LOGIN_FAILED,
            actorId: userId,
            targetType: AUDIT_TARGETS.USER,
            targetId: userId,
            metadata: shouldLock ? { lockoutMinutes } : { attempt: rows[0]?.attempts ?? null, maxAttempts },
            context,
        });
    }

    /**
     * SECURITY FIX (SEC-009): verifies a TOTP code AND records its time step atomically, so the
     * same code cannot be replayed within its validity window (intercepted code, shoulder
     * surfing, double submission). Returns false for an invalid or already-used code.
     */
    private async verifyTotpOnce(userId: string, encryptedSecret: string, code: string): Promise<boolean> {
        const result = await this.mfaService.verifyWithStep(encryptedSecret, code);
        if (!result.valid) return false;
        if (result.timeStep === undefined) return true;

        const updated = await this.prisma.$executeRaw`
            UPDATE user_mfa
            SET "lastUsedStep" = ${result.timeStep}
            WHERE "userId" = ${userId}
              AND ("lastUsedStep" IS NULL OR "lastUsedStep" < ${result.timeStep})`;
        return updated === 1;
    }

    /**
     * SECURITY FIX (SEC-002): revokes every active refresh token of a user. Called on
     * suspension, disabling, anonymization and when refresh-token reuse is detected.
     */
    async revokeAllRefreshTokens(userId: string): Promise<number> {
        const result = await this.prisma.refreshToken.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt: new Date() },
        });
        return result.count;
    }

    /**
     * Confirms, on behalf of a GENERATED BACKEND, that a BackOS user currently holds a valid
     * authenticator (TOTP) code - the "internal login" of a generated backend's Auth & User service.
     *
     * The TOTP secret never leaves BackOS: the generated backend only ever receives the yes/no
     * answer (and the username). The same protections as `login()` apply, deliberately sharing its
     * counter: an ACTIVE account, a working MFA enrolment, and the lockout policy - so guessing
     * codes through a generated backend is exactly as hard as guessing them on BackOS itself.
     * (The flip side: repeated wrong codes typed into a generated backend's login also lock the
     * user out of BackOS for the same cool-down.)
     *
     * Every failure is the same generic 401, whatever the reason.
     *
     * @param userId - BackOS user whose code is being checked.
     * @param totpCode - The 6-digit code the person typed.
     * @param platformId - The platform whose generated backend asked (audit trail only).
     * @param context - Audit metadata (the caller is the generated backend, not the end user).
     * @returns The user's id and username.
     * @throws UnauthorizedException when the account, MFA or code is not valid.
     */
    async verifyTotpForGeneratedBackend(
        userId: string,
        totpCode: string,
        platformId: string,
        context: AuditContext,
    ): Promise<{ userId: string; username: string }> {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user || user.status !== UserStatus.ACTIVE) {
            throw new UnauthorizedException('Invalid credentials.');
        }

        if (user.lockedUntil && user.lockedUntil > new Date()) {
            throw new UnauthorizedException('Invalid credentials.');
        }

        const mfa = await this.prisma.userMfa.findUnique({ where: { userId: user.id } });
        if (!mfa || mfa.status !== MfaStatus.ACTIVE) {
            throw new UnauthorizedException('Invalid credentials.');
        }

        const isValid = await this.verifyTotpOnce(user.id, mfa.secretEncrypted, totpCode);
        if (!isValid) {
            await this.registerFailedLoginAttempt(user.id, context);
            throw new UnauthorizedException('Invalid credentials.');
        }

        if (user.failedLoginAttempts > 0 || user.lockedUntil) {
            await this.prisma.user.update({
                where: { id: user.id },
                data: { failedLoginAttempts: 0, lockedUntil: null },
            });
        }

        await this.auditLog.log({
            action: AUDIT_ACTIONS.LOGIN,
            actorId: user.id,
            targetType: AUDIT_TARGETS.USER,
            targetId: user.id,
            metadata: { channel: 'generated-backend', platformId },
            context,
        });

        return { userId: user.id, username: user.username };
    }

    /**
     * Lighter counterpart of `verifyTotpForGeneratedBackend()`, without a code: is this user still
     * an ACTIVE BackOS account? Used by a generated backend when renewing a session.
     *
     * @throws UnauthorizedException when the account no longer exists or is not active.
     */
    async assertActiveUserForGeneratedBackend(userId: string): Promise<{ userId: string; username: string }> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, username: true, status: true },
        });
        if (!user || user.status !== UserStatus.ACTIVE) {
            throw new UnauthorizedException('Invalid credentials.');
        }
        return { userId: user.id, username: user.username };
    }

    /**
     * Authenticates a user emergency backup access using a single-use recovery code.
     * Supports authentication via either work email or username.
     * * Process Flow:
     * 1. Fetches user by work email OR username, ensuring account status is `ACTIVE`.
     * 2. Retrieves all active, unused recovery code hashes for the user.
     * 3. Hashes user-provided code (normalized to uppercase) and compares it against active candidates.
     * 4. Rejects request with generic error and logs audit event if no match is found.
     * 5. Consumes recovery code by setting `usedAt` timestamp.
     * 6. Logs a successful `login.recovery_success` audit event.
     * 7. Issues and returns fresh Access and Refresh JWT tokens.
     * * @param dto - Data Transfer Object containing login identifier and plain recovery code.
     * @param context - Request audit context (client IP address and User-Agent).
     * @returns Object containing newly issued authentication JWT tokens.
     * @throws UnauthorizedException with generic error message on any failure.
     */
    async loginWithRecoveryCode(dto: RecoveryLoginDto, context: AuditContext) {
        // 1. Fetch user by work email OR username where status is ACTIVE
        const user = await this.prisma.user.findFirst({
            where: {
                OR: [{ workEmail: dto.loginIdentifier }, { username: dto.loginIdentifier }],
            },
        });

        if (!user || user.status !== UserStatus.ACTIVE) {
            throw new UnauthorizedException('Invalid credentials.');
        }

        // 2. Retrieve unused recovery codes for the target user
        const candidates = await this.prisma.recoveryCode.findMany({
            where: { userId: user.id, usedAt: null },
        });

        // 3. Normalize input to uppercase and hash for lookup
        //
        // SECURITY FIX (audit #9 - medium): previously compared with strict `===`, which is not
        // constant-time. Real-world exploitability was low here (both sides are SHA-256 hashes
        // of unpredictable values, not a secret compared directly), but `crypto.timingSafeEqual`
        // is cheap defense-in-depth and keeps this consistent with best practice for any secret
        // comparison. `timingSafeEqual` requires equal-length buffers, so length is checked
        // first (a length mismatch is not itself a hash and is safely rejected as no match).
        const codeHash = this.recoveryCode.hashRecoveryCode(dto.recoveryCode.toUpperCase());
        const codeHashBuffer = Buffer.from(codeHash, 'hex');
        const match = candidates.find((c) => {
            const candidateBuffer = Buffer.from(c.codeHash, 'hex');
            return candidateBuffer.length === codeHashBuffer.length && timingSafeEqual(candidateBuffer, codeHashBuffer);
        });

        // 4. Handle invalid or already consumed recovery code
        if (!match) {
            throw new UnauthorizedException('Invalid credentials.');
        }

        // 5. Consume recovery code (single-use, enforced atomically against concurrent use)
        const consumed = await this.prisma.recoveryCode.updateMany({
            where: { id: match.id, usedAt: null },
            data: { usedAt: new Date() },
        });
        if (consumed.count === 0) {
            throw new UnauthorizedException('Invalid credentials.');
        }

        // 6. Record successful recovery login event
        await this.auditLog.log({
            action: AUDIT_ACTIONS.RECOVERY_CODE_USED,
            actorId: user.id,
            targetType: AUDIT_TARGETS.USER,
            targetId: user.id,
            context,
        });

        // 7. Issue and return authentication JWT tokens
        return this.issueTokens(user.id, user.workEmail);
    }

    // ---- Step-up re-authentication ----

    /**
     * SECURITY FIX (audit #3 - elevated): re-verifies a fresh TOTP code for an already
     * authenticated user, for use as "step-up" authentication before destructive,
     * irreversible, self-service actions (currently: `DELETE /users/me`).
     *
     * Why this is needed: this system is passwordless (identifier + TOTP only, see the
     * dedicated design note on `login()`), so a 15-minute access token is the only thing an
     * attacker needs to trigger a self-service action once issued - e.g. an intercepted token
     * (XSS, a compromised device, a proxy log) could otherwise permanently delete the victim's
     * account with no further proof of possession of their TOTP device. Requiring a fresh code
     * here closes that window without reintroducing a password.
     *
     * Deliberately mirrors the same generic-failure-message pattern as `login()` - the caller
     * receives no information distinguishing "wrong code" from any other failure mode, to avoid
     * turning this into an oracle for anything about the account's MFA state.
     *
     * @param userId - The already-authenticated user being asked to re-prove possession of
     *   their TOTP device.
     * @param totpCode - The fresh 6-digit code supplied for this specific action.
     * @param context - Audit metadata (IP address, user agent) for the security audit trail.
     * @throws UnauthorizedException if the user, their MFA configuration, or the supplied code
     *   is not currently valid.
     */
    async verifyStepUpTotp(userId: string, totpCode: string, context: AuditContext): Promise<void> {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user || user.status !== UserStatus.ACTIVE) {
            throw new UnauthorizedException('Re-authentication failed.');
        }

        const mfa = await this.prisma.userMfa.findUnique({ where: { userId: user.id } });
        if (!mfa || mfa.status !== MfaStatus.ACTIVE) {
            throw new UnauthorizedException('Re-authentication failed.');
        }

        const isValid = await this.verifyTotpOnce(user.id, mfa.secretEncrypted, totpCode);
        if (!isValid) {
            await this.auditLog.log({
                action: AUDIT_ACTIONS.STEP_UP_FAILED,
                actorId: user.id,
                targetType: AUDIT_TARGETS.USER,
                targetId: user.id,
                context,
            });
            throw new UnauthorizedException('Re-authentication failed.');
        }
    }

    // ---- Refresh / Logout ----

    /**
     * Rotates an existing refresh token to issue a new access token and refresh token pair.
     * * Implementation Details:
     * Uses Refresh Token Rotation. When a refresh token is presented, it is immediately revoked
     * (marked as used via `revokedAt`) and a brand new token pair is issued.
     * * Process Flow:
     * 1. Hashes incoming raw refresh token string for lookup.
     * 2. Fetches matching token record from database along with associated User details.
     * 3. Validates that token exists, has not been revoked, and has not expired.
     * 4. Revokes presented token (`revokedAt = new Date()`).
     * 5. Generates and returns a fresh pair of Access and Refresh JWT tokens.
     * * @param rawRefreshToken - Unhashed refresh token string provided by client.
     * @returns Object containing newly issued Access and Refresh JWT tokens.
     * @throws UnauthorizedException if token is invalid, expired, or previously revoked.
     */
    async refreshTokens(rawRefreshToken: string) {
        const tokenHashValue = hashToken(rawRefreshToken);

        const stored = await this.prisma.refreshToken.findUnique({
            where: { tokenHash: tokenHashValue },
            include: { user: true },
        });

        if (!stored || stored.expiresAt < new Date()) {
            throw new UnauthorizedException('Invalid or expired session. Please log in again.');
        }

        // SECURITY FIX (SEC-010): presenting an already-rotated token is the signature of a
        // stolen token being replayed. Outside a short grace window (two browser tabs refreshing
        // at the same moment), every session of the user is revoked.
        if (stored.revokedAt) {
            const REUSE_GRACE_MS = 10_000;
            if (Date.now() - stored.revokedAt.getTime() > REUSE_GRACE_MS) {
                await this.revokeAllRefreshTokens(stored.userId);
                await this.auditLog.log({
                    action: AUDIT_ACTIONS.LOGOUT,
                    actorId: stored.userId,
                    targetType: AUDIT_TARGETS.USER,
                    targetId: stored.userId,
                    metadata: { reason: 'refresh-token-reuse-detected' },
                });
            }
            throw new UnauthorizedException('Invalid or expired session. Please log in again.');
        }

        // SECURITY FIX (SEC-002): a suspended, disabled or deleted account can no longer renew
        // its session - it used to keep access forever through token rotation.
        if (stored.user.status !== UserStatus.ACTIVE) {
            await this.revokeAllRefreshTokens(stored.userId);
            throw new UnauthorizedException('Invalid or expired session. Please log in again.');
        }

        // CONCURRENCY FIX (SEC-010): conditional revocation - of two concurrent refreshes with
        // the same token, only one can win and receive a new pair.
        const revoked = await this.prisma.refreshToken.updateMany({
            where: { id: stored.id, revokedAt: null },
            data: { revokedAt: new Date() },
        });
        if (revoked.count === 0) {
            throw new UnauthorizedException('Invalid or expired session. Please log in again.');
        }

        return this.issueTokens(stored.user.id, stored.user.workEmail);
    }

    /**
     * Logs out a user by revoking their active refresh token.
     * * Process Flow:
     * 1. Hashes provided raw refresh token string for lookup.
     * 2. Locates and updates active token records matching both `userId` and `tokenHash`.
     * 3. Sets `revokedAt` timestamp to invalidate the session in the database.
     * 4. Returns confirmation message indicating successful logout.
     * * @param userId - Unique identifier of the user logging out.
     * @param rawRefreshToken - Raw refresh token string provided by client.
     * @returns Object containing a success confirmation message.
     */
    async logout(userId: string, rawRefreshToken: string) {
        // 1. Hash incoming raw refresh token string
        const tokenHashValue = hashToken(rawRefreshToken);

        // 2. Revoke active refresh token for the specific user
        await this.prisma.refreshToken.updateMany({
            where: {
                userId,
                tokenHash: tokenHashValue,
                revokedAt: null,
            },
            data: {
                revokedAt: new Date(),
            },
        });

        // 3. Return standardized success response
        return { message: 'Successfully logged out.' };
    }

    // ---- Helpers ----

    /**
     * Helper method to locate and validate an invitation by its raw token string.
     * * Validation Steps:
     * 1. Hashes raw token to locate corresponding invitation record in database.
     * 2. Throws `NotFoundException` if no matching record exists.
     * 3. Throws `UnauthorizedException` if invitation has already been consumed (`used: true`).
     * 4. Throws `UnauthorizedException` if invitation has passed its expiration timestamp.
     * * @param rawToken - Plain invitation token received from client query parameter.
     * @returns Validated invitation record populated with associated user entity.
     * @throws NotFoundException if invitation token does not exist.
     * @throws UnauthorizedException if invitation is already used or expired.
     */
    private async findValidInvitationByToken(rawToken: string) {
        // 1. Hash raw token and search for unique invitation record
        const invitation = await this.prisma.invitation.findUnique({
            where: { tokenHash: hashToken(rawToken) },
            include: { user: true },
        });

        // 2. Validate existence
        if (!invitation) {
            throw new NotFoundException('Invitation not found.');
        }

        // 3. Ensure token has not already been consumed
        if (invitation.used) {
            throw new UnauthorizedException('This invitation has already been used.');
        }

        // 4. Ensure token has not expired
        if (invitation.expiresAt < new Date()) {
            throw new UnauthorizedException('Invitation link has expired.');
        }

        return invitation;
    }

    /**
     * Helper method to aggregate all unique permissions granted to a user through their assigned roles.
     *
     * NOTE: this now simply delegates to `RoleHierarchyService.getEffectivePermissionKeys`, which is
     * the single shared implementation also used by the privilege-escalation guard in
     * `RoleHierarchyService.assertPermissionsAreOwnedByActor`. Having ONE source of truth for
     * "what permissions does this user actually have" avoids the JWT payload and the authorization
     * checks silently drifting apart from each other over time.
     *
     * @param userId - Unique identifier of the user whose permissions are being retrieved.
     * @returns Promise resolving to an array of unique permission keys (e.g., `['users.read', 'users.update']`).
     */
    private async getPermissionsForUser(userId: string): Promise<string[]> {
        const permissionKeys = await this.roleHierarchy.getEffectivePermissionKeys(userId);
        return Array.from(permissionKeys);
    }

    /**
     * Helper method to issue a new JWT Access Token and persistent Refresh Token pair.
     * * Process Flow:
     * 1. Fetches all aggregated permissions associated with user ID.
     * 2. Signs short-lived JWT Access Token containing user identity (`sub`, `email`) and permissions.
     * 3. Generates cryptographically secure 64-byte raw refresh token string.
     * 4. Hashes refresh token and stores it in database with configurable expiration period.
     * 5. Returns both signed JWT access token and unhashed raw refresh token to client.
     * * @param userId - Unique identifier of user receiving authentication tokens.
     * @param email - Primary work email of user (embedded into JWT payload).
     * @returns Object containing generated `accessToken` (JWT) and `refreshToken` (opaque raw string).
     */
    private async issueTokens(userId: string, email: string) {
        // 1. Retrieve aggregated user permissions for JWT payload claims
        const permissions = await this.getPermissionsForUser(userId);

        // 2. Generate signed JWT Access Token
        const accessToken = this.jwtService.sign({
            sub: userId,
            email,
            permissions,
        });

        // 3. Generate raw refresh token and retrieve expiration window from configuration namespace
        const rawRefreshToken = generateSecureToken(64);
        // CONFIG FIX (ARCH-003): was 'auth.refreshTokenExpiresInDays' (non-existent namespace).
        const expiresInDays = this.configService.get<number>('jwt.refreshTokenExpiresInDays', 7);

        // 4. Persist hashed refresh token with expiration timestamp
        await this.prisma.refreshToken.create({
            data: {
                userId,
                tokenHash: hashToken(rawRefreshToken),
                expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000),
            },
        });

        // 5. Return token pair to client
        return {
            accessToken,
            refreshToken: rawRefreshToken,
        };
    }
}
