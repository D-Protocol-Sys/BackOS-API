import { ServiceBlueprint } from '../service-blueprint.types';

export const SCHEDULER_BLUEPRINT: ServiceBlueprint = {
    key: 'scheduler',
    name: 'Scheduler',
    description:
        "Fenêtres de disponibilité sur les tables, et actions différées (email ou webhook), ponctuelles ou récurrentes.",
    pnpmDependencies: {
        bullmq: '^5.34.0',
        ioredis: '^5.4.1',
    },
    configFields: [
        { key: 'smtpHost', label: 'Hôte SMTP (requis si tu utilises des actions "email")', secret: false, required: false },
        { key: 'smtpPort', label: 'Port SMTP', secret: false, required: false, placeholder: '587' },
        { key: 'smtpUser', label: 'Utilisateur SMTP', secret: false, required: false },
        { key: 'smtpPassword', label: 'Mot de passe SMTP', secret: true, required: false },
        { key: 'fromEmail', label: 'Adresse expéditeur', secret: false, required: false },
    ],
    prismaModels: `
        model ScheduledTask {
            id             String   @id @default(uuid())
            name           String
            actionType     String   // "email" | "webhook"
            triggerType    String   // "once" | "cron"
            runAt          DateTime?
            cronExpression String?
            payload        Json
            isActive       Boolean  @default(true)
            lastRunAt      DateTime?
            lastStatus     String?

            createdAt DateTime @default(now())
            updatedAt DateTime @updatedAt

            @@map("scheduled_tasks")
        }
    `,
};