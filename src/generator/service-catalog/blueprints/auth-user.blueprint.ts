import { ServiceBlueprint } from '../service-blueprint.types';

/**
 * Service blueprint configuration for the "Auth & User" pluggable module.
 * * This blueprint serves as a declarative manifest defining:
 * 1. Package dependencies required to inject into target generated applications.
 * 2. Environment/configuration fields required to operate the service.
 * 3. Prisma Schema DSL models injected dynamically during code generation.
 */
export const AUTH_USER_BLUEPRINT: ServiceBlueprint = {

    // Unique blueprint identifier key used across the code generation engine
    key: 'auth-user',
    name: 'Auth & User',
    description: 'OTP email-based authentication and user management for the generated platform.',

    // Required npm/pnpm dependencies injected into the target project's package.json
    pnpmDependencies: {
        '@nestjs/jwt': '^11.0.0',
        '@nestjs/passport': '^11.0.0',
        'passport': '^0.7.0',
        'passport-jwt': '^4.0.1',
        'bcrypt': '^5.1.1',
        'nodemailer': '^6.9.16',
    },

    // Config fields required from tenant users upon activating this service
    configFields: [
        { key: 'jwtSecret', label: 'Secret JWT', secret: true, required: true },
        { key: 'jwtExpiresIn', label: 'Durée de validité du token', secret: false, required: false, placeholder: '15m' },
        { key: 'smtpHost', label: 'Hôte SMTP', secret: false, required: true },
        { key: 'smtpPort', label: 'Port SMTP', secret: false, required: true, placeholder: '587' },
        { key: 'smtpUser', label: 'Utilisateur SMTP', secret: false, required: true },
        { key: 'smtpPassword', label: 'Mot de passe SMTP', secret: true, required: true },
        { key: 'fromEmail', label: 'Adresse expéditeur', secret: false, required: true },
    ],

    // Embedded Prisma Schema snippet injected into the generated project's schema.prisma
    prismaModels: `
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

            @@map("app_users")
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
            userId    String
            user      AppUser   @relation(fields: [userId], references: [id], onDelete: Cascade)
            expiresAt DateTime
            revokedAt DateTime?
            createdAt DateTime  @default(now())

            @@index([userId])
            @@map("app_refresh_tokens")
        }
    `,
};