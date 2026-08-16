import {
    Injectable,
    UnauthorizedException,
    NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { AuditLogService, AuditContext } from '../audit/audit-log.service';
import { MfaService } from '../common/services/mfa.service';
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

        const INVITATION_EXPIRES_IN_HOURS = this.configService.get<number>(
            'mfa.invitationExpiresInHours', 
            48,
        );
        const expiresAt = new Date( Date.now() + INVITATION_EXPIRES_IN_HOURS * 60 * 60 * 1000 );

        // 3. Persist hashed invitation credentials and expiration date
        const invitation = await this.prisma.invitation.create({
            data: {
                userId: user.id,
                tokenHash,
                codeHash,
                expiresAt
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
            await this.emailService.sendMail( user.personalEmail!, subject, text, html );
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
                    reason:
                        error instanceof Error
                            ? error.message
                            : 'Unknown email error',
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
            email: invitation.user.workEmail 
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

        const maxAttempts = this.configService.get<number>('totp.maxAttempts', 5);

        // 2. Lock out request if attempt threshold has been reached
        if (invitation.attempts >= maxAttempts) {
            await this.auditLog.log({
                action: AUDIT_ACTIONS.INVITATION_LOCKED,
                actorId: invitation.userId,
                targetType: AUDIT_TARGETS.INVITATION,
                targetId: invitation.id,
                metadata: {
                    attempts: invitation.attempts,
                    maxAttempts,
                },
                context,
            });

            throw new UnauthorizedException('Too many failed attempts. Invitation has been invalidated.');
        }

        // 3. Compare provided raw code with stored hash
        const isValidCode = await bcrypt.compare(dto.code, invitation.codeHash);
        
        if (!isValidCode) {
            await this.prisma.invitation.update({
                where: { id: invitation.id },
                data: { attempts: { increment: 1 } },
            });

            throw new UnauthorizedException('Invalid verification code.');
        }

        // 4. Mark invitation as successfully consumed
        await this.prisma.invitation.update({
            where: { id: invitation.id },
            data: { used: true, usedAt: new Date() },
        });

        await this.auditLog.log({
            action: AUDIT_ACTIONS.INVITATION_USED,
            actorId: invitation.userId,
            targetType: AUDIT_TARGETS.INVITATION,
            targetId: invitation.id,
            metadata: { invitedUser: invitation.user },
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
            otpauthUri: enrollment.uri 
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

        // 3. Verify TOTP code via MfaService
        const isValid = await this.mfaService.verify(mfa.secretEncrypted, dto.totpCode);
        if (!isValid) {
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
    async login(dto: LoginDto, context: AuditContext) {
        // 1. Fetch user by work email OR username where status is ACTIVE
        const user = await this.prisma.user.findFirst({
            where: {
                OR: [
                    { workEmail: dto.loginIdentifier },
                    { username: dto.loginIdentifier },
                ],
            },
        });

        if (!user || user.status !== UserStatus.ACTIVE) {
            throw new UnauthorizedException('Invalid credentials.');
        }

        // 2. Fetch MFA configuration and ensure MFA is fully active
        const mfa = await this.prisma.userMfa.findUnique({ where: { userId: user.id } });
        if (!mfa || mfa.status !== MfaStatus.ACTIVE) {
            throw new UnauthorizedException('Invalid credentials.');
        }

        // 3. Verify TOTP code via MfaService
        const isValid = await this.mfaService.verify(mfa.secretEncrypted, dto.totpCode);
        if (!isValid) {
            throw new UnauthorizedException('Invalid credentials.');
        }

        // 4. Record successful login event in security audit log
        await this.auditLog.log({
            action: AUDIT_ACTIONS.LOGIN,
            actorId: user.id,
            targetType: AUDIT_TARGETS.USER,
            targetId: user.id,
            context,
        });

        // 5. Issue and return authentication JWT tokens
        return this.issueTokens(user.id, user.workEmail);
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
                OR: [
                    { workEmail: dto.loginIdentifier },
                    { username: dto.loginIdentifier },
                ],
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
        const codeHash = this.recoveryCode.hashRecoveryCode(dto.recoveryCode.toUpperCase());
        const match = candidates.find((c) => c.codeHash === codeHash);

        // 4. Handle invalid or already consumed recovery code
        if (!match) {
            throw new UnauthorizedException('Invalid credentials.');
        }

        // 5. Consume recovery code (single-use enforcement)
        await this.prisma.recoveryCode.update({ 
            where: { id: match.id }, 
            data: { usedAt: new Date() }, 
        });

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
        // 1. Hash raw refresh token to locate record in database
        const tokenHashValue = hashToken(rawRefreshToken);
        
        const stored = await this.prisma.refreshToken.findUnique({
            where: { tokenHash: tokenHashValue },
            include: { user: true },
        });

        // 2. Validate token existence, expiration, and revocation status
        if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
            throw new UnauthorizedException('Invalid or expired session. Please log in again.');
        }

        // 3. Immediately revoke current token (Token Rotation Pattern)
        await this.prisma.refreshToken.update({ 
            where: { id: stored.id }, 
            data: { revokedAt: new Date() }, 
        });

        // 4. Issue and return a new token pair
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
                revokedAt: null 
            },
            data: { 
                revokedAt: new Date() 
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
     * * Process Flow:
     * 1. Fetches all user-role mappings for specified user ID.
     * 2. Nestedly includes associated role permissions and underlying permission entities.
     * 3. Iterates over roles and permissions, inserting keys into a `Set` to eliminate duplicates.
     * 4. Converts and returns set as an array of unique permission key strings.
     * * @param userId - Unique identifier of the user whose permissions are being retrieved.
     * @returns Promise resolving to an array of unique permission keys (e.g., `['user.read', 'user.write']`).
     */
    private async getPermissionsForUser(userId: string): Promise<string[]> {
        // 1. Fetch user roles with full permission tree mapping
        const userRoles = await this.prisma.userRole.findMany({
            where: { userId },
            include: { 
                role: { 
                    include: { 
                        rolePermissions: { 
                            include: { permission: true } 
                        } 
                    } 
                } 
            },
        });

        // 2. Aggregate unique permission keys using a Set to prevent duplicates
        const set = new Set<string>();
        for (const ur of userRoles) {
            for (const rp of ur.role.rolePermissions) {
                set.add(rp.permission.key);
            }
        }

        // 3. Convert Set back into a standard string array
        return Array.from(set);
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
            permissions 
        });

        // 3. Generate raw refresh token and retrieve expiration window from configuration namespace
        const rawRefreshToken = generateSecureToken(64);
        const expiresInDays = this.configService.get<number>('auth.refreshTokenExpiresInDays', 7);

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
            refreshToken: rawRefreshToken 
        };
    }
}