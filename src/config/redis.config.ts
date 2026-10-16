import { registerAs } from '@nestjs/config';

/**
 * Redis In-Memory Database Configuration Namespace ('redis')
 * * Groups connection settings for caching, session storage, and background queues.
 * Accessible via `ConfigService.get('redis.property')`.
 */
export default registerAs('redis', () => ({
    /**
     * Hostname or IP address of the Redis server.
     * * Fallback: 'localhost'
     */
    host: process.env.REDIS_HOST,

    /**
     * Listening port of the Redis service.
     * `parseInt` converts the environment string into a base-10 integer.
     * * Fallback: 6379
     */
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
}));
