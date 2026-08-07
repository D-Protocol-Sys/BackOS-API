import appConfig from './app.config';
import databaseConfig from './database.config';
import redisConfig from './redis.config';
import jwtConfig from './jwt.config';
import totpConfig from './mfa.config';
import securityConfig from './security.config';
import mailConfig from './mail.config';
import cleanupConfig from './cleanup.config';
import ownerConfig from './owner.config';

/**
 * Configuration Loaders Array
 * * Aggregates all modular configuration namespaces into a single array.
 * Passed directly to NestJS `ConfigModule.forRoot({ load: configuration })`
 * to register all configuration factories at application startup.
 */
export default [
    appConfig,
    databaseConfig,
    redisConfig,
    jwtConfig,
    totpConfig,
    securityConfig,
    mailConfig,
    cleanupConfig,
    ownerConfig,
];