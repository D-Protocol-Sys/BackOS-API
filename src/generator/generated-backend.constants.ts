/**
 * Single source of truth for the internal HTTP route prefix used by EVERY generated backend.
 *
 * Before this constant existed, the string `'api'` was hardcoded independently in two places:
 *   1. `mainTsTemplate()` -> `app.setGlobalPrefix('api')` (written into the generated project's
 *      own `src/main.ts`).
 *   2. `generated-backend-proxy.middleware.ts` -> `pathRewrite` (rewrites
 *      `/generated/<slug>/...` to `/api/...` before forwarding to the generated backend).
 *
 * Two independent copies of the same "magic string" is a coherence hazard: if one is ever
 * edited without the other, the gateway silently starts 404-ing every generated backend. It
 * also happened to collide with the ORCHESTRATOR's (this BackOS process) own prefix - see
 * `app.setGlobalPrefix('api')` in the root `main.ts` - which made logs, docs, and traces
 * ambiguous about which "/api" was being talked about even though the two never actually
 * shared a port.
 *
 * `GENERATED_BACKEND_API_PREFIX` is deliberately DIFFERENT from the orchestrator's own `api`
 * prefix so that the two are unambiguous wherever they show up together (logs, Swagger titles,
 * proxy rewrite rules) - and it is imported everywhere a generated backend's internal prefix is
 * needed, so there is exactly one place to change it.
 */
export const GENERATED_BACKEND_API_PREFIX = 'generated-api';

/**
 * Fixed internal HTTP port every generated backend's Docker container listens on. The
 * PLATFORM-SPECIFIC, dynamically-allocated port (`PortAllocatorService`) is only ever used as
 * the HOST side of the Docker port mapping (`127.0.0.1:<allocatedPort>:<this port>`) - see
 * `docker-runtime-manager.service.ts`. Keeping the container-internal port fixed means the
 * generated app's own code/config never needs to know which host port it was assigned.
 */
export const GENERATED_BACKEND_CONTAINER_PORT = 3000;
