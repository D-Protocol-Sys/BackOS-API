/**
 * Configuration Barrel Export Module (`index.ts`)
 * * Centralizes and re-exports all configuration namespaces from a single point of entry.
 * Simplifies imports across the application (e.g., in `AppModule`).
 */

export { default as configuration } from './configuration';

export { default as appConfig } from './app.config';

export { default as databaseConfig } from './database.config';

export { default as redisConfig } from './redis.config';

export { default as jwtConfig } from './jwt.config';

export { default as totpConfig } from './mfa.config';

export { default as securityConfig } from './security.config';

export { default as mailConfig } from './mail.config';

export { default as cleanupConfig } from './cleanup.config';

export { default as ownerConfig } from './owner.config';

export { validationSchema } from './env.validation';