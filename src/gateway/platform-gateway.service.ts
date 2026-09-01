import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The information the gateway needs to decide whether (and where) to proxy a request for a
 * given generated backend.
 */
export interface GatewayTarget {
    /** Internal loopback port the generated backend's HTTP server is listening on. */
    port: number;
    /** Host the generated backend is bound to (see `GENERATED_BACKEND_HOST`, default `127.0.0.1`). */
    host: string;
}

interface CacheEntry {
    target: GatewayTarget | null;
    expiresAt: number;
}

/**
 * Resolves a platform `slug` (as seen in a public URL like
 * `https://backos.example.com/generated/portfolio/getprojects`) to the *internal* loopback
 * address of the generated backend process currently serving that platform, if any.
 *
 * WHY THIS SERVICE EXISTS (see also `GATEWAY_README.md` in this folder): generated backends
 * are deliberately never exposed directly on the public network - they bind only to
 * `127.0.0.1` (see `RuntimeManagerService.start()` and the generated `mainTsTemplate()`). The
 * only supported way to reach a generated backend from outside the host machine is through
 * this gateway, mounted in `main.ts` at `GENERATED_BACKEND_GATEWAY_PREFIX` (default
 * `/generated`). This keeps the "front door" of the whole system to a single, well-understood
 * surface (one TLS certificate, one port open to the internet - the main BackOS API) instead
 * of an ever-growing, per-platform range of raw ports that would each need to be individually
 * firewalled, TLS-terminated, and monitored.
 *
 * A short in-memory cache avoids a database round-trip on every single proxied request (which
 * would otherwise happen on the hot path of every API call made to every generated backend).
 * `RuntimeManagerService` proactively calls `invalidate()` whenever a platform's runtime state
 * changes (start/stop/crash-detected), so the cache TTL below is a safety net for staleness,
 * not the only mechanism keeping this correct.
 */
@Injectable()
export class PlatformGatewayService {
    private readonly logger = new Logger(PlatformGatewayService.name);

    /** How long a resolved (or "not found") lookup is trusted before being re-fetched from the database. */
    private static readonly CACHE_TTL_MS = 5_000;

    private readonly cache = new Map<string, CacheEntry>();

    constructor(
        private readonly prisma: PrismaService,
        private readonly configService: ConfigService,
    ) {}

    /**
     * Resolves the internal address a request for `slug` should be proxied to.
     *
     * Returns `null` (never throws) when the slug does not exist, or exists but is not
     * currently in a routable runtime state - the caller (the gateway middleware) is
     * responsible for turning that into an HTTP 404, so that the *existence* of a platform is
     * not leaked to unauthenticated callers through a different status code (e.g. 503 vs 404).
     *
     * @param slug - The platform slug taken from the incoming request path.
     */
    async resolveTarget(slug: string): Promise<GatewayTarget | null> {
        const cached = this.cache.get(slug);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.target;
        }

        const platform = await this.prisma.platform.findUnique({
            where: { slug },
            select: { generatedPort: true, runtimeStatus: true, status: true },
        });

        // Only proxy to platforms that are administratively ACTIVE and whose runtime is not
        // known to be down - a platform mid-generation, stopped, or crashed must not receive
        // traffic, since there is either no listener behind the port at all, or the listener
        // belongs to a stale/previous generation.
        //
        // BUGFIX: this used to require `runtimeStatus === 'RUNNING'` exactly. But the ONLY
        // thing that ever flips a container from 'STARTING' to 'RUNNING' in the database is
        // `DockerRuntimeManagerService.pingHealth()`, which itself only runs as a side effect
        // of something calling `getStatus()` (the `GET .../runtime/status` endpoint). A
        // container can be fully up and serving traffic - exactly like the generated backend's
        // own startup log ("Nest application successfully started") - while `runtimeStatus`
        // sits at 'STARTING' in the database indefinitely, simply because nothing happened to
        // poll status yet. That left every request through this gateway 404ing for a healthy
        // backend until some unrelated code path happened to call `getStatus()` first.
        // Treating 'STARTING' as routable too removes that hidden dependency: if the container
        // isn't actually ready yet, the proxy's own `error` handler already turns a connection
        // refusal into a clean 502 (see `generated-backend-proxy.middleware.ts`), which is no
        // worse than the 404 this used to return - but a healthy 'STARTING' backend now works
        // immediately instead of only after some other code path incidentally warms the status.
        const isRoutable =
            !!platform &&
            platform.status === 'ACTIVE' &&
            (platform.runtimeStatus === 'RUNNING' || platform.runtimeStatus === 'STARTING') &&
            !!platform.generatedPort;

        const target: GatewayTarget | null = isRoutable
            ? {
                  port: platform!.generatedPort as number,
                  host: this.configService.get<string>('GENERATED_BACKEND_HOST', '127.0.0.1'),
              }
            : null;

        this.cache.set(slug, { target, expiresAt: Date.now() + PlatformGatewayService.CACHE_TTL_MS });
        return target;
    }

    /**
     * Forces the next `resolveTarget()` call for `slug` to bypass the cache and hit the
     * database again. Called by `RuntimeManagerService` immediately after any action that
     * changes whether/where a platform is routable (start, stop, crash detection, or a
     * STARTING -> RUNNING health-check transition).
     *
     * @param slug - The platform slug whose cached lookup should be discarded.
     */
    invalidate(slug: string): void {
        this.cache.delete(slug);
        this.logger.debug(`Gateway cache invalidated for platform "${slug}".`);
    }
}
