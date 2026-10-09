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
    // SECURITY FIX (audit #4): number of trusted reverse-proxy hops in front of this app (see
    // `main.ts`'s `app.set('trust proxy', ...)`). Defaults to 1 - a single Traefik hop, matching
    // `deploy/docker-compose.prod.yml`. Raise it only if another trusted hop is added in front.
    // SECURITY FIX (SEC-016): default is now 0 (trust nobody). The LAN/local stacks publish the
    // API directly, where trusting one hop let any client forge X-Forwarded-For and bypass the
    // per-IP throttling. The Traefik-fronted stacks (prod, demo) set TRUST_PROXY_HOPS=1 explicitly.
    TRUST_PROXY_HOPS: Joi.number().integer().min(0).default(0),

    // --- DATABASES (POSTGRES & REDIS) ---
    DATABASE_URL: Joi.string().required(),
    POSTGRES_PROVISIONING_URL: Joi.string().required(),
    // Pre-existing gap, unrelated to the shadow-database addition below: these three are read
    // via `configService.get()` with in-code defaults (see database.config.ts /
    // provisioning.service.ts) but were never declared here, so they silently bypassed startup
    // validation entirely. Declared now so a typo'd value fails fast at boot instead of
    // surfacing later as a confusing provisioning error.
    POSTGRES_PROVISIONING_ROLE: Joi.string().required(),
    PROVISION_HOST: Joi.string().default('localhost'),
    PROVISION_PORT: Joi.number().default(5432),
    // Backs ProvisioningService.ensureShadowDatabaseUrl() - see the class-level comment there.
    POSTGRES_SHADOW_DATABASE_NAME: Joi.string().default('backos_migration_shadow'),
    REDIS_HOST: Joi.string(),
    REDIS_PORT: Joi.number().default(6379),
    // QUEUE-001: every containerized stack runs Redis with --requirepass - mandatory in production.
    REDIS_PASSWORD: Joi.string().allow('').when('NODE_ENV', {
        is: 'production',
        then: Joi.string().min(16).required(),
        otherwise: Joi.optional(),
    }),
    REDIS_USERNAME: Joi.string().allow('').optional(),
    REDIS_TLS: Joi.boolean().default(false),

    // --- SECURITY & CRYPTOGRAPHY ---
    // SEC-021 / OPS-001: exactly 64 HEXADECIMAL characters (a 63-character key used to slip into .env.lan).
    ENCRYPTION_KEY: Joi.string().pattern(/^[0-9a-fA-F]{64}$/).required()
        .messages({ 'string.pattern.base': 'ENCRYPTION_KEY must be exactly 64 hexadecimal characters (openssl rand -hex 32).' }),
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
    GENERATION_MAX_AUTO_RESTARTS: Joi.number().integer().min(0).default(3),

    // --- STORAGE ---
    // FILE-001: absolute path of the persistent uploads directory (mounted as a volume in Docker).
    UPLOAD_DIR: Joi.string().default('./uploads'),
    // FILE-002: per-user storage quota for uploaded files, in megabytes.
    USER_UPLOAD_QUOTA_MB: Joi.number().integer().min(1).default(1024),

    // --- ACCOUNT LIFECYCLE ---
    DEACTIVATION_GRACE_PERIOD_DAYS: Joi.number().integer().min(0).default(60),

    // --- GENERATED BACKEND GATEWAY (see src/gateway/) ---
    // Generated child backends now ALWAYS bind to a loopback-only host and are never reachable
    // directly from the public internet - the parent application proxies public traffic to them
    // internally. See src/gateway/GATEWAY_README.md for the full rationale.
    GENERATED_BACKEND_HOST: Joi.string().default('127.0.0.1'),
    // Whether generated backends mount their interactive Swagger docs (`/generated/<slug>/docs`).
    // Left unset, it follows the orchestrator: on outside `production`, off in `production`.
    // Set it to `true` / `false` to force either way.
    GENERATED_BACKEND_API_DOCS_ENABLED: Joi.boolean().optional(),
    // Address the ORCHESTRATOR uses to reach generated backends (gateway + health check). Optional:
    // falls back to GENERATED_BACKEND_HOST / localhost. Needed when the orchestrator runs inside a
    // container (e.g. `host.docker.internal`), where 127.0.0.1 is the container itself.
    GENERATED_BACKEND_GATEWAY_HOST: Joi.string().optional(),
    // Store generated backends' uploads in a Docker named volume instead of a host bind mount - see
    // DockerRuntimeManagerService.start(). Set to true when the orchestrator runs in a container
    // that does not mount the projects folder at an identical host path (Windows/LAN stack).
    GENERATED_BACKEND_UPLOADS_USE_VOLUME: Joi.boolean().default(false),
    // Restart, a few seconds after the orchestrator boots, the generated backends that were running
    // before a host/Docker restart (see RuntimeRecoveryService). Platforms stopped on purpose are
    // never restarted.
    GENERATED_BACKEND_AUTO_RESTORE: Joi.boolean().default(true),
    GENERATED_BACKEND_RESTORE_DELAY_MS: Joi.number().integer().min(0).default(5000),
    GENERATED_BACKEND_RESTORE_ATTEMPTS: Joi.number().integer().min(1).max(10).default(3),
    GENERATED_BACKEND_RESTORE_RETRY_DELAY_MS: Joi.number().integer().min(0).default(15000),
    GENERATED_BACKEND_GATEWAY_PREFIX: Joi.string().default('/generated'),
    // SEC-015: dedicated Redis for the Scheduler service of generated backends (never the
    // orchestrator's own Redis in production).
    GENERATED_BACKEND_REDIS_HOST: Joi.string().optional(),
    GENERATED_BACKEND_REDIS_PORT: Joi.number().optional(),
    GENERATED_BACKEND_REDIS_PASSWORD: Joi.string().allow('').optional(),
    // Base URL a generated backend calls to have BackOS verify an internal login (BackOS username +
    // authenticator code) - see `InternalGeneratedAuthController`. Optional: when unset it defaults
    // to `http://host.docker.internal:<PORT>` (the host, as seen from a generated Docker container).
    // Set it when BackOS itself runs in a container, or generated backends run as native processes
    // (e.g. `http://127.0.0.1:4803`). No trailing path.
    GENERATED_BACKEND_BACKOS_URL: Joi.string().uri({ scheme: ['http', 'https'] }).optional(),

    // --- GENERATED BACKEND DOCKER ISOLATION (see DockerRuntimeManagerService) ---
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
    // SECURITY FIX (audit #6 - elevated): dumps produced by `POST /backup/platforms` that are
    // never downloaded (no route existed at all to download them before this fix - see
    // `BackupController.download()`) used to accumulate on disk forever. `CleanupService` now
    // purges any `.sql.gz` dump older than this many hours as a backstop, regardless of whether
    // it was ever claimed - see `CleanupService.cleanupBackupDumps()`.
    BACKUP_DUMP_RETENTION_HOURS: Joi.number().default(48),

    // --- PUBLIC DEMO (see DemoReadOnlyGuard) ---
    DEMO_WORKEMAIL: Joi.string().email().optional(),

    // --- DATABASE POOL (DB-009) ---
    DATABASE_POOL_MAX: Joi.number().integer().min(1).default(10),

    // --- MISC (audit correction pass) ---
    SMTP_REQUIRE_TLS: Joi.boolean().default(true),
    LOG_FORMAT: Joi.string().valid('json', 'text').default('text'),
    SEED_ACTIVATION_FILE: Joi.string().optional(),

    // --- SEED / SYSTEM OWNER IDENTITY ---
    OWNER_WORKEMAIL: Joi.string().email().required(),
    OWNER_PERSONALEMAIL: Joi.string().email().required(),
    OWNER_FIRSTNAME: Joi.string().required(),
    OWNER_LASTNAME: Joi.string().required(),
    OWNER_USERNAME: Joi.string().required(),

});