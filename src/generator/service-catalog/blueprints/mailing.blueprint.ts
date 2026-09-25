import { ServiceBlueprint } from '../service-blueprint.types';

/**
 * Service blueprint configuration for the "Mailing" pluggable module.
 * * This blueprint serves as a declarative manifest defining:
 * 1. Package dependencies required for sending emails via SMTP.
 * 2. Environment/configuration fields needed to connect to the email server.
 * 3. Optional integration guardrails with other services (e.g., Auth & User dependency).
 *
 * Mailing is the ONE place where SMTP is configured. "Auth & User" (OTP e-mails) and "Scheduler"
 * (e-mail actions) both declare `dependsOn: ['mailing']` and send through the generated
 * `MailService` instead of carrying their own SMTP settings - so Mailing must be enabled first.
 */
export const MAILING_BLUEPRINT: ServiceBlueprint = {

    // Unique blueprint identifier key used across the code generation engine
    key: 'mailing',
    name: 'Mailing',
    description: 'Transactional email dispatching via SMTP for the platform. Required by Auth & User and Scheduler.',

    // Required npm/pnpm dependencies injected into the target project's package.json
    pnpmDependencies: {
        'nodemailer': '^6.9.16',
    },

    pnpmDevDependencies: {
        '@types/nodemailer': '^6.4.17',
    },

    // Config fields required from tenant users upon activating this service
    configFields: [
        { key: 'smtpHost', label: 'Hôte SMTP', secret: false, required: true },
        { key: 'smtpPort', label: 'Port SMTP', secret: false, required: true, placeholder: '587' },
        { key: 'smtpUser', label: 'Utilisateur SMTP', secret: false, required: true },
        { key: 'smtpPassword', label: 'Mot de passe SMTP', secret: true, required: true },
        { key: 'fromEmail', label: 'Adresse expéditeur', secret: false, required: true },
        { key: 'requiresAuth', label: 'Protéger /mail/send (nécessite Auth & User actif)', secret: false, required: false, type: 'boolean', placeholder: 'false' },
    ],

};
