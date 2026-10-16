import { registerAs } from '@nestjs/config';

/**
 * Application Configuration Namespace ('app')
 * * Using NestJS `registerAs` allows us to group related environment variables
 * under a single configuration namespace. This provides type safety and
 * easy access via `ConfigService.get('app.property')`.
 */
export default registerAs('app', () => ({
    serverName: process.env.SERVER_NAME,

    /**
     * Application execution environment.
     * Typical values: 'development', 'staging', 'production', or 'test'.
     * Fallback: 'development'
     */
    nodeEnv: process.env.NODE_ENV,

    /**
     * The HTTP port on which the NestJS application server will listen.
     * `parseInt` converts the environment string into a base-10 number.
     * Fallback: 4803
     */
    port: parseInt(process.env.PORT ?? '4803', 10),

    /**
     * Allowed Cross-Origin Resource Sharing (CORS) origin.
     * Controls which domain is permitted to send requests to this API.
     */
    corsOrigin: process.env.CORS_ORIGIN,

    /**
     * Base URL of the frontend application.
     * Used for generating full links (e.g., account activation, password reset).
     */
    frontendUrl: process.env.FRONTEND_URL,

    /**
     * The cost factor / number of salt rounds used by bcrypt for hashing sensitive data.
     * Higher values increase security against brute-force attacks but slow down hashing speed.
     * Fallback: 12
     */
    bcryptSaltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS ?? '12', 10),

    /**
     * The root directory path where generated projects or files will be saved on the disk.
     */
    generatedProjectsRoot: process.env.GENERATED_PROJECTS_ROOT,

    /**
     * Maximum duration (in milliseconds) allowed for running generation CLI/system commands
     * before timing out. (e.g., 300,000 ms = 5 minutes).
     * Fallback: 300000
     */
    generationCommandTimeoutMs: parseInt(process.env.GENERATION_COMMAND_TIMEOUT_MS ?? '300000', 10),

    /**
     * Starting port number for assigning dynamic network ports to generated application instances.
     * Fallback: 4100
     */
    generationPortRangeStart: parseInt(process.env.GENERATION_PORT_RANGE_START ?? '4100', 10),

    /**
     * Ending port number for the dynamic port allocation range.
     * Fallback: 4999
     */
    generationPortRangeEnd: parseInt(process.env.GENERATION_PORT_RANGE_END ?? '4999', 10),
}));
