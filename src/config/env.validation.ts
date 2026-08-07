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
    DATABASE_PROVISIONING_URL: Joi.string().required(),
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

    // --- PROJECT GENERATION ENGINE ---
    GENERATED_PROJECTS_ROOT: Joi.string().default('generated'),
    GENERATION_COMMAND_TIMEOUT_MS: Joi.number().default(300000),
    GENERATION_PORT_RANGE_START: Joi.number().default(4100),
    GENERATION_PORT_RANGE_END: Joi.number().default(4999),

    // --- SEED / SYSTEM OWNER IDENTITY ---
    OWNER_WORKEMAIL: Joi.string().email().required(),
    OWNER_PERSONALEMAIL: Joi.string().email().required(),
    OWNER_FIRST_NAME: Joi.string().required(),
    OWNER_LAST_NAME: Joi.string().required(),
    OWNER_USERNAME: Joi.string().required(),

});