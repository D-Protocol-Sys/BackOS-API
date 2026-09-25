import { ServiceBlueprint } from '../service-blueprint.types';

/**
 * Service blueprint configuration for the "Scheduler" pluggable module.
 * * This blueprint defines:
 * 1. Distributed task queue and Redis dependencies (BullMQ + ioredis).
 * 2. The dependencies: Mailing (through which the "email" action of a scheduled task is sent, so
 *    SMTP is no longer configured here) and Auth & User (which protects the task routes and the
 *    unpublished records of schedulable entities).
 * 3. Prisma database schema models required for persisting scheduled job definitions.
 */
export const SCHEDULER_BLUEPRINT: ServiceBlueprint = {

    // Unique blueprint identifier key used across the code generation engine
    key: 'scheduler',
    name: 'Scheduler',
    description: 'Availability windows on entities and delayed actions (email or webhook), one-time or recurring. Requires Mailing (its "email" actions) and Auth & User (its API is reserved to internal accounts).',

    // - mailing:   its "email" action goes through the generated MailService.
    // - auth-user: the task routes can send e-mails and call arbitrary URLs, so they are restricted to
    //              internal accounts; and the read routes of schedulable entities only show unpublished
    //              records to internal accounts. Neither can be enforced without Auth & User.
    dependsOn: ['mailing', 'auth-user'],

    // Required npm/pnpm dependencies for background job management via Redis queues
    pnpmDependencies: {
        '@nestjs/bullmq': '^11.0.0',
        'bullmq': '^5.34.0',
        'ioredis': '^5.4.1',
    },

    // Nothing to configure here: e-mail settings come from Mailing.
    configFields: [],

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
