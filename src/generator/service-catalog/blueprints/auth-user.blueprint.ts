import { ServiceBlueprint } from '../service-blueprint.types';
import { buildAuthUserPrismaModels } from './auth-user.prisma-models';

/**
 * Service blueprint configuration for the "Auth & User" pluggable module.
 * * This blueprint serves as a declarative manifest defining:
 * 1. Package dependencies required to inject into target generated applications.
 * 2. Environment/configuration fields required to operate the service.
 * 3. Prisma Schema models injected dynamically during code generation.
 *
 * TWO DISTINCT WAYS TO LOG IN to a generated backend:
 *   - INTERNAL (always on): the BackOS username of whoever generated the backend + their current
 *     authenticator (TOTP) code. The code is verified by BackOS itself - the generated backend
 *     never holds the TOTP secret.
 *   - EXTERNAL (only when `allowExternalUsers` is on): visitors / customers of the generated
 *     product sign up with last name, first name and e-mail + an e-mail code, then log in with
 *     their e-mail + a fresh e-mail code. Their profile fields are defined afterwards through
 *     `PUT /platforms/:id/services/auth-user/profile-fields`.
 *
 * E-mails (the OTP codes) are sent through the Mailing service, hence `dependsOn: ['mailing']`:
 * SMTP is configured once, on Mailing, instead of being duplicated here.
 */
export const AUTH_USER_BLUEPRINT: ServiceBlueprint = {

    // Unique blueprint identifier key used across the code generation engine
    key: 'auth-user',
    name: 'Auth & User',
    description: 'Authentication for the generated platform: internal login with BackOS username + authenticator code, and optional e-mail OTP sign-up / login for external users.',

    // Sends its OTP e-mails through the generated MailService.
    dependsOn: ['mailing'],

    // Required npm/pnpm dependencies injected into the target project's package.json
    pnpmDependencies: {
        '@nestjs/jwt': '^11.0.0',
        '@nestjs/passport': '^11.0.0',
        'passport': '^0.7.0',
        'passport-jwt': '^4.0.1',
        'bcrypt': '^5.1.1',
    },

    pnpmDevDependencies: {
        '@types/passport-jwt': '^4.0.1',
        '@types/bcrypt': '^5.0.2',
    },

    // Config fields required from tenant users upon activating this service
    configFields: [
        { key: 'jwtSecret', label: 'Secret JWT', secret: true, required: true },
        { key: 'jwtExpiresIn', label: 'Durée de validité du token', secret: false, required: false, placeholder: '15m' },
        {
            key: 'allowExternalUsers',
            label: 'Ouvrir aussi ce service aux utilisateurs externes ?',
            description: 'Si activé, les visiteurs pourront créer un compte (nom, prénom, e-mail + code OTP reçu par e-mail) et se connecter avec leur e-mail + un nouveau code. Vous définirez ensuite les champs de leur profil. Sinon, seule la connexion interne (username + code authenticator) existe.',
            secret: false,
            required: false,
            type: 'boolean',
            placeholder: 'false',
        },

        // ---- Internal fields (never shown in forms, see ServiceConfigField.system) ----
        // Shared secret proving to BackOS that a verification request really comes from THIS
        // platform's generated backend. Generated once, on first activation.
        { key: 'internalAuthKey', label: 'Clé interne BackOS', secret: true, required: false, system: true, autoGenerate: true },
        // Profile fields of external users - edited through the dedicated profile-fields endpoint.
        { key: 'profileFields', label: 'Champs du profil externe', secret: false, required: false, system: true },
    ],

    // Prisma models: the identity tables are fixed, the profile table depends on `profileFields`.
    prismaModels: (config) => buildAuthUserPrismaModels(config),
};
