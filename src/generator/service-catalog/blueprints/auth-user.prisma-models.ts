import { toCamelCase } from '../../../common/utils/case.util';
import { FIELD_TYPE_TO_PRISMA } from '../../../common/utils/field-type-mapper.util';
import { readProfileFields } from '../profile-fields.util';

/**
 * True when the platform owner opened sign-up to EXTERNAL users (the visitors / customers of the
 * generated product), as opposed to internal staff only. Accepts the strings "true"/"false" too,
 * since older stored configs and hand-written API calls may carry either form.
 */
export function isExternalUsersEnabled(config: Record<string, unknown>): boolean {
    return config.allowExternalUsers === true || config.allowExternalUsers === 'true';
}

/**
 * Builds the Prisma schema block of the "Auth & User" service.
 *
 * The identity tables are ALWAYS emitted - even when external users are disabled - so that
 * switching that option on or off later never drops or recreates a table (and never loses the
 * accounts already in it). Only the PROFILE table is conditional, because its columns are the
 * fields the platform owner defined for external users' profiles:
 *
 *   AppInternalAccount  staff who log in with their BackOS username + current authenticator code
 *   AppUser             external users (sign-up / login by e-mail OTP)
 *   AppSignupRequest    a sign-up waiting for its e-mail code - the AppUser row only exists once
 *                       the address is proven, so nobody can create or alter an account for an
 *                       e-mail they do not own
 *   AppOtpCode          login codes for an existing AppUser
 *   AppRefreshToken     rotating refresh tokens, for either kind of account
 *   AppUserProfile      (optional) the owner-defined profile of an AppUser
 *
 * PROFILE columns are all nullable (or `[]` for arrays): the row is created lazily on the first
 * profile save and users fill it in progressively, so "required" is a completeness rule reported
 * by the API (`profileComplete`), not a database constraint.
 */
export function buildAuthUserPrismaModels(config: Record<string, unknown>): string {
    const profileFields = isExternalUsersEnabled(config) ? readProfileFields(config) : [];
    const hasProfile = profileFields.length > 0;

    const profileColumns = profileFields
        .map((field) => {
            const name = toCamelCase(field.column);
            const prismaType = FIELD_TYPE_TO_PRISMA[field.type as keyof typeof FIELD_TYPE_TO_PRISMA];
            return field.isArray ? `    ${name} ${prismaType}[] @default([])` : `    ${name} ${prismaType}?`;
        })
        .join('\n');

    const profileModel = hasProfile
        ? `
        model AppUserProfile {
            id     String  @id @default(uuid())
            userId String  @unique
            user   AppUser @relation(fields: [userId], references: [id], onDelete: Cascade)

${profileColumns}

            createdAt DateTime @default(now())
            updatedAt DateTime @updatedAt

            @@map("app_user_profiles")
        }
`
        : '';

    return `
        model AppInternalAccount {
            id           String  @id @default(uuid())
            backosUserId String  @unique
            username     String  @unique
            isActive     Boolean @default(true)

            createdAt DateTime @default(now())
            updatedAt DateTime @updatedAt

            refreshTokens AppRefreshToken[]

            @@map("app_internal_accounts")
        }

        model AppUser {
            id        String   @id @default(uuid())
            email     String   @unique
            firstName String
            lastName  String
            isActive  Boolean  @default(true)

            createdAt DateTime @default(now())
            updatedAt DateTime @updatedAt

            otpCodes      AppOtpCode[]
            refreshTokens AppRefreshToken[]
${hasProfile ? '            profile       AppUserProfile?\n' : ''}
            @@map("app_users")
        }

        model AppSignupRequest {
            id         String    @id @default(uuid())
            email      String
            firstName  String
            lastName   String
            codeHash   String
            attempts   Int       @default(0)
            expiresAt  DateTime
            consumedAt DateTime?
            createdAt  DateTime  @default(now())

            @@index([email])
            @@map("app_signup_requests")
        }

        model AppOtpCode {
            id     String  @id @default(uuid())
            userId String
            user   AppUser @relation(fields: [userId], references: [id], onDelete: Cascade)

            codeHash String
            attempts Int    @default(0)

            expiresAt  DateTime
            consumedAt DateTime?
            createdAt  DateTime  @default(now())

            @@index([userId])
            @@map("app_otp_codes")
        }

        model AppRefreshToken {
            id        String    @id @default(uuid())
            tokenHash String    @unique

            userId String?
            user   AppUser? @relation(fields: [userId], references: [id], onDelete: Cascade)

            internalAccountId String?
            internalAccount   AppInternalAccount? @relation(fields: [internalAccountId], references: [id], onDelete: Cascade)

            expiresAt DateTime
            revokedAt DateTime?
            createdAt DateTime  @default(now())

            @@index([userId])
            @@index([internalAccountId])
            @@map("app_refresh_tokens")
        }
${profileModel}`;
}
