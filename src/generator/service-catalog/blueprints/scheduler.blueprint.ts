import { ServiceBlueprint } from '../service-blueprint.types';

/**
 * Service blueprint configuration for the "Scheduler" pluggable module.
 * * This blueprint defines:
 * 1. Distributed task queue and Redis dependencies (BullMQ + ioredis).
 * 2. Optional SMTP configuration fields for delayed or recurring email tasks.
 * 3. Prisma database schema models required for persisting scheduled job definitions.
 */
export const SCHEDULER_BLUEPRINT: ServiceBlueprint = {

    // Unique blueprint identifier key used across the code generation engine
    key: 'scheduler',
    name: 'Scheduler',
    description: 'Availability windows on entities and delayed actions (email or webhook), one-time or recurring.',

    // Required npm/pnpm dependencies for background job management via Redis queues
    pnpmDependencies: {
        '@nestjs/bullmq': '^11.0.0',
        'bullmq': '^5.34.0',
        'ioredis': '^5.4.1',
        'nodemailer': '^6.9.16',
    },

    pnpmDevDependencies: {
        '@types/nodemailer': '^6.4.17',
    },

    // Config fields for email dispatches triggered by scheduled jobs (all optional)
    configFields: [
        { key: 'smtpHost', label: 'Hôte SMTP (requis si tu utilises des actions "email")', secret: false, required: false },
        { key: 'smtpPort', label: 'Port SMTP', secret: false, required: false, placeholder: '587' },
        { key: 'smtpUser', label: 'Utilisateur SMTP', secret: false, required: false },
        { key: 'smtpPassword', label: 'Mot de passe SMTP', secret: true, required: false },
        { key: 'fromEmail', label: 'Adresse expéditeur', secret: false, required: false },
    ],

    // Embedded Prisma Schema snippet managing persistent job metadata
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