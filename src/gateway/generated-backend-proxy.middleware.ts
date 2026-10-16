import { Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { PlatformGatewayService } from './platform-gateway.service';
import { GENERATED_BACKEND_API_PREFIX } from '../generator/generated-backend.constants';

const logger = new Logger('GeneratedBackendGateway');

/** Matches the leading `/generated/<slug>` (or configured prefix) segment of the request path. */
function extractSlug(requestPath: string, gatewayPrefix: string): string | null {
    const escapedPrefix = gatewayPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = requestPath.match(new RegExp(`^${escapedPrefix}/([a-z0-9-]+)(?:/|$)`, 'i'));
    return match ? match[1] : null;
}

/**
 * Builds the Express middleware that turns `https://<your-domain>/generated/<slug>/...` into a
 * reverse-proxied call to the correct generated backend's internal loopback port, answering
 * the question this file exists to solve: *"when a new backend is generated in production,
 * does it automatically live under the parent domain, e.g.
 * `backos.com/generated/portfolio/getprojects`?"* - with this middleware mounted, yes.
 *
 * See `GATEWAY_README.md` in this folder for the full design rationale, and
 * `PlatformGatewayService` for how a slug is resolved to an internal address.
 *
 * REQUEST FLOW:
 *   1. `GET https://backos.com/generated/portfolio/getprojects` arrives at the parent BackOS
 *      Node.js process (the only process with a port open to the public internet).
 *   2. This middleware extracts the slug (`portfolio`) from the path.
 *   3. `PlatformGatewayService.resolveTarget('portfolio')` looks up the platform's internal
 *      `127.0.0.1:<port>` address, but ONLY if it is administratively ACTIVE and its runtime
 *      is currently RUNNING.
 *   4. If routable, the request is transparently forwarded to
 *      `http://127.0.0.1:<port>/generated-api/getprojects` (the `/generated/<slug>` prefix is
 *      stripped and replaced with the generated backend's own internal prefix - see
 *      `GENERATED_BACKEND_API_PREFIX` and `pathRewrite` below).
 *   5. If not routable (unknown slug, platform not ACTIVE, or backend not currently running),
 *      the request is answered with a generic 404 - deliberately NOT distinguishing "this
 *      platform does not exist" from "this platform exists but is stopped", to avoid leaking
 *      which platform slugs are valid to an unauthenticated caller.
 *
 * NEW DEPENDENCY: this file uses `http-proxy-middleware`, a well-established reverse proxy
 * library (used internally by webpack-dev-server, create-react-app, and many production
 * gateways). It must be added to `package.json`:
 *     npm install http-proxy-middleware
 *
 * @param platformGateway - Resolves platform slugs to internal targets.
 * @param gatewayPrefix - The public path prefix this gateway is mounted under (default `/generated`).
 */
export function createGeneratedBackendProxyMiddleware(platformGateway: PlatformGatewayService, gatewayPrefix: string) {
    // `http-proxy-middleware` needs a synchronous `target`, so we use its `router` option to
    // resolve the target dynamically per-request from our async `PlatformGatewayService`.
    // Requests for a slug that cannot be resolved are intercepted and answered with 404 BEFORE
    // ever reaching the proxy itself (see the wrapping handler below), so `router` here only
    // ever needs to run for requests we have already confirmed are routable.
    const proxy = createProxyMiddleware({
        changeOrigin: true,
        ws: true, // Forward WebSocket upgrade requests too, in case a generated backend uses them.
        pathRewrite: (path: string) => {
            // Strips the public `/generated/<slug>` prefix and replaces it with the generated
            // backend's own internal prefix (GENERATED_BACKEND_API_PREFIX, set by
            // `mainTsTemplate()` via the SAME shared constant - so this can never silently
            // drift out of sync with what the generated backend actually mounts).
            // e.g. "/generated/portfolio/getprojects" -> "/generated-api/getprojects"
            const stripped = path.replace(new RegExp(`^${gatewayPrefix}/[a-z0-9-]+`, 'i'), '');
            return `/${GENERATED_BACKEND_API_PREFIX}${stripped}`;
        },
        router: async (req) => {
            const slug = extractSlug(req.url ?? '', gatewayPrefix);
            const target = slug ? await platformGateway.resolveTarget(slug) : null;
            // This branch should not normally be reached, since the wrapping middleware below
            // already rejects unroutable requests before calling `proxy`. It is kept as a
            // last-resort fallback in case of a race between the pre-check and this lookup.
            return target ? `http://${target.host}:${target.port}` : undefined;
        },
        on: {
            // SECURITY MITIGATION (SEC-017): generated backends are served on the orchestrator's
            // own origin. Any HTML they return (API docs, a tenant-uploaded file...) is sandboxed
            // into an opaque origin, so its scripts can never read BackOS cookies / storage or
            // call the BackOS API as the logged-in user. JSON and binary responses are untouched.
            // A dedicated domain for generated backends remains the recommended long-term setup.
            proxyRes: (proxyRes) => {
                const contentType = String(proxyRes.headers['content-type'] ?? '');
                if (contentType.includes('html') || contentType.includes('svg') || contentType.includes('xml')) {
                    proxyRes.headers['content-security-policy'] =
                        'sandbox allow-scripts allow-forms allow-popups allow-downloads';
                }
                proxyRes.headers['x-content-type-options'] = 'nosniff';
            },
            error: (err, req, res) => {
                logger.warn(`Proxy error for ${req.url}: ${err.message}`);
                if (res && 'writeHead' in res && !res.headersSent) {
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(
                        JSON.stringify({ statusCode: 502, message: 'The generated backend is currently unreachable.' }),
                    );
                }
            },
        },
    });

    return async function generatedBackendGatewayMiddleware(req: Request, res: Response, next: NextFunction) {
        const slug = extractSlug(req.path, gatewayPrefix);

        if (!slug) {
            // Not a `/generated/<slug>/...` request at all - fall through to the rest of the
            // application (this middleware is mounted globally, ahead of Nest's own router).
            next();
            return;
        }

        const target = await platformGateway.resolveTarget(slug);
        if (!target) {
            // Deliberately generic: do not reveal whether `slug` is an unknown platform, an
            // inactive one, or one whose backend process is simply not running right now.
            res.status(404).json({ statusCode: 404, message: 'Not found.' });
            return;
        }

        void proxy(req, res, next);
    };
}
