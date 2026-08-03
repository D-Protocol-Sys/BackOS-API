import { ServiceBlueprint } from '../service-blueprint.types';

export const MAILING_BLUEPRINT: ServiceBlueprint = {

    key: 'mailing',
    name: 'Mailing',
    description: "Envoi d'emails transactionnels via SMTP pour cette plateforme.",
    pnpmDependencies: {
        nodemailer: '^6.9.16',
    },
    configFields: [
        { key: 'smtpHost', label: 'Hôte SMTP', secret: false, required: true },
        { key: 'smtpPort', label: 'Port SMTP', secret: false, required: true, placeholder: '587' },
        { key: 'smtpUser', label: 'Utilisateur SMTP', secret: false, required: true },
        { key: 'smtpPassword', label: 'Mot de passe SMTP', secret: true, required: true },
        { key: 'fromEmail', label: 'Adresse expéditeur', secret: false, required: true },
    ],

};