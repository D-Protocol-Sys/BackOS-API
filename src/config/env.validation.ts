import * as Joi from 'joi';

export const validationSchema = Joi.object({

    NODE_ENV: Joi.string()
        .valid('development', 'test', 'production')
        .default('development'),

    PORT: Joi.number().default(4803),

    DATABASE_URL: Joi.string().required(),

    JWT_SECRET: Joi.string().required(),

    JWT_EXPIRES_IN: Joi.string().default('15m'),

    REFRESH_TOKEN_EXPIRES_IN_DAYS: Joi.number().default(7),

    BCRYPT_SALT_ROUNDS: Joi.number().default(12),

    OTP_EXPIRES_IN_MINUTES: Joi.number().default(10),

    OTP_MAX_ATTEMPTS: Joi.number().default(5),

    SMTP_HOST: Joi.string().required(),

    SMTP_PORT: Joi.number().default(587),

    SMTP_SECURE: Joi.boolean().default(false),

    SMTP_USER: Joi.string().required(),

    SMTP_PASSWORD: Joi.string().required(),

    SMTP_FROM: Joi.string().required(),
});