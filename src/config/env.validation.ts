import * as Joi from 'joi';

/**
 * Environment Variables Validation Schema
 * * Validates all process.env variables at application startup using Joi.
 * Prevents the application from booting if critical configuration keys are missing or invalid.
 */
export const validationSchema = Joi.object({

    // --- APPLICATION & ENVIRONMENT ---
    SERVER_NAME: Joi.string().required(),
    NODE_ENV: Joi.string()
        .valid('development', 'test', 'production')
        .default('development'),
    PORT: Joi.number().default(4803),
    CORS_ORIGIN: Joi.string(),
    FRONTEND_URL: Joi.string(),

    // --- DATABASES (POSTGRES & REDIS) ---
    DATABASE_URL: Joi.string().required(),
    POSTGRES_PROVISIONING_URL: Joi.string().required(),
    // Pre-existing gap, unrelated to the shadow-database addition below: these three are read
    // via `configService.get()` with in-code defaults (see database.config.ts /
    // provisioning.service.ts) but were never declared here, so they silently bypassed startup
    // validation entirely. Declared now so a typo'd value fails fast at boot instead of
    // surfacing later as a confusing provisioning error.
    POSTGRES_PROVISIONING_ROLE: Joi.string(),
    PROVISION_HOST: Joi.string().default('localhost'),
    PROVISION_PORT: Joi.number().default(5432),
    // Backs ProvisioningService.ensureShadowDatabaseUrl() - see the class-level comment there.
    POSTGRES_SHADOW_DATABASE_NAME: Joi.string().default('backos_migration_shadow'),
    REDIS_HOST: Joi.string(),
    REDIS_PORT: Joi.number().default(6379),

    // --- SECURITY & CRYPTOGRAPHY ---
    ENCRYPTION_KEY: Joi.string().length(64).required(), // 256-bit hex key (64 characters)
    BCRYPT_SALT_ROUNDS: Joi.number().default(12),

    // --- JWT & REFRESH TOKENS ---
    JWT_SECRET: Joi.string().min(32).required(),
    JWT_ACCESS_EXPIRES_IN: Joi.string().default('15m'),
    REFRESH_TOKEN_EXPIRES_IN_DAYS: Joi.number().default(7),

    // --- OTP & TOTP AUTHENTICATION ---
    OTP_EXPIRES_IN_MINUTES: Joi.number().default(10),
    INVITATION_MAX_ATTEMPTS: Joi.number().default(5),
    INVITATION_EXPIRES_IN_HOURS: Joi.number().default(48),

    // --- CLEANUP & RETENTION POLICIES ---
    OTP_CLEANUP_RETENTION_DAYS: Joi.number().default(7),
    REFRESH_TOKEN_CLEANUP_RETENTION_DAYS: Joi.number().default(30),

    // --- MAIL / SMTP TRANSPORT ---
    SMTP_HOST: Joi.string().required(),
    SMTP_PORT: Joi.number().default(587),
    SMTP_SECURE: Joi.boolean().default(false),
    SMTP_USER: Joi.string().required(),
    SMTP_PASSWORD: Joi.string().required(),
    SMTP_FROM: Joi.string().required(),

    // --- LOGIN BRUTE-FORCE PROTECTION ---
    LOGIN_LOCKOUT_MAX_ATTEMPTS: Joi.number().default(5),
    LOGIN_LOCKOUT_MINUTES: Joi.number().default(15),

    // --- PROJECT GENERATION ENGINE ---
    GENERATED_PROJECTS_ROOT: Joi.string().default('generated'),
    GENERATION_COMMAND_TIMEOUT_MS: Joi.number().default(300000),
    GENERATION_PORT_RANGE_START: Joi.number().default(4100),
    GENERATION_PORT_RANGE_END: Joi.number().default(4999),

    // --- GENERATED BACKEND GATEWAY (see src/gateway/) ---
    // Generated child backends now ALWAYS bind to a loopback-only host and are never reachable
    // directly from the public internet - the parent application proxies public traffic to them
    // internally. See src/gateway/GATEWAY_README.md for the full rationale.
    GENERATED_BACKEND_HOST: Joi.string().default('127.0.0.1'),
    GENERATED_BACKEND_GATEWAY_PREFIX: Joi.string().default('/generated'),

    // --- GENERATED BACKEND DOCKER ISOLATION (see DockerRuntimeManagerService, opt-in) ---
    GENERATED_BACKEND_MEMORY_LIMIT: Joi.string().default('256m'),
    GENERATED_BACKEND_CPU_LIMIT: Joi.string().default('0.5'),
    // SECURITY: prefix for each platform's OWN dedicated Docker network
    // (`<prefix>-<slug>`), created lazily by `DockerRuntimeManagerService.ensurePlatformNetwork()`.
    // Deliberately NOT a single shared network - see that method's doc comment for why letting
    // every tenant's generated backend reach every other tenant's on a shared network was a
    // lateral-movement hole.
    GENERATED_BACKEND_DOCKER_NETWORK: Joi.string().default('backos-gen-net'),
    // Name of the Docker container/Compose service running the shared Postgres instance, so
    // `DockerRuntimeManagerService.ensureDatabaseReachableOnNetwork()` can attach it to each
    // platform's dedicated network (see `docker-compose.prod.yml`, service `postgres`). Leave
    // unset when Postgres is an external/managed database (RDS, Cloud SQL, ...) that isn't a
    // container on this Docker daemon at all - nothing needs connecting in that case.
    GENERATED_BACKEND_DB_CONTAINER_NAME: Joi.string().allow('').default(''),
    // Hostname a generated backend's Docker container must use to reach the database - see
    // `DockerRuntimeManagerService.dockerReachableDatabaseUrl()` for the two deployment shapes
    // this covers (bare-metal orchestrator via `host.docker.internal`, or fully containerized
    // prod via the Postgres Compose service name, e.g. `postgres`).
    GENERATED_BACKEND_DOCKER_DB_HOST: Joi.string().default('host.docker.internal'),

    // --- DATABASE BACKUPS (see src/backup/) ---
    BACKUP_OUTPUT_DIR: Joi.string().default('backups'),
    BACKUP_TIMEOUT_MS: Joi.number().default(600000),

    // --- SEED / SYSTEM OWNER IDENTITY ---
    OWNER_WORKEMAIL: Joi.string().email().required(),
    OWNER_PERSONALEMAIL: Joi.string().email().required(),
    OWNER_FIRSTNAME: Joi.string().required(),
    OWNER_LASTNAME: Joi.string().required(),
    OWNER_USERNAME: Joi.string().required(),

});