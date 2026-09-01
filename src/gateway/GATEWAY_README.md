# Generated Backend Gateway

## The problem this solves

Before this module existed, every backend produced by the generator (`src/generator/`) ran as
a fully independent Node.js process, listening directly on a raw TCP port picked from a range
(`GENERATION_PORT_RANGE_START`-`GENERATION_PORT_RANGE_END`, default `4100`-`4999`), bound to
**every** network interface (`0.0.0.0`) by default.

That meant two things in production, once the parent BackOS API is deployed behind a real
domain (e.g. `backos.com`):

1. There was **no** `backos.com/generated/<slug>/...` routing at all. A generated backend was
   only reachable via its own raw port, e.g. `backos.com:4123/api/getprojects` - assuming that
   port range was even open to the public internet, which it usually should not be.
2. Because generated backends bound to `0.0.0.0`, if that port range *was* reachable (e.g. a
   permissive cloud security group, or no firewall at all), every generated backend was a
   directly-reachable, independently-authenticated HTTP service with no shared security
   perimeter, no shared TLS termination, and no central place to rate-limit or monitor traffic.

## The fix

Two changes work together:

### 1. Generated backends are now loopback-only

`RuntimeManagerService.start()` always sets `HOST=127.0.0.1` (configurable via
`GENERATED_BACKEND_HOST`) in the child process's environment, and the generated `main.ts`
(`mainTsTemplate()` in `src/generator/templates/generated-project.templates.ts`) calls
`app.listen(port, host)` with that value. A generated backend can now only be reached by other
processes on the *same machine* - never directly from the network, regardless of firewall
configuration.

### 2. A reverse proxy in the parent process exposes them under one domain

This `gateway` module adds:

- `PlatformGatewayService` - resolves a platform `slug` to its current internal
  `127.0.0.1:<port>` address, but only when the platform is `ACTIVE` *and* its runtime is
  currently `RUNNING`. Backed by a short (5s) in-memory cache, proactively invalidated by
  `RuntimeManagerService` on every start/stop/crash/health-check transition.
- `createGeneratedBackendProxyMiddleware()` - an Express middleware (built on the well-known
  `http-proxy-middleware` package) mounted in `main.ts` at `GENERATED_BACKEND_GATEWAY_PREFIX`
  (default `/generated`), which forwards
  `https://backos.com/generated/<slug>/<anything>` to
  `http://127.0.0.1:<port>/api/<anything>` on the correct generated backend.
- `createGatewayRateLimiter()` - a lightweight, in-memory, per-IP rate limiter specific to this
  proxy path. It exists because this middleware intentionally runs *before* Nest's own router
  (see "Why raw middleware, not a controller?" below), so `ThrottlerGuard` (a NestJS
  `APP_GUARD`) never sees these requests.

### End-to-end example

```
Public request:   GET https://backos.com/generated/portfolio/getprojects
                              |
                              v
            [ BackOS parent process - the only port open to the internet ]
                              |
              gatewayRateLimiterMiddleware (per-IP throttle)
                              |
              generatedBackendGatewayMiddleware
                - extracts slug "portfolio"
                - PlatformGatewayService.resolveTarget("portfolio")
                    -> ACTIVE + RUNNING?  yes  -> { host: 127.0.0.1, port: 4231 }
                    -> otherwise                -> 404, request stops here
                              |
                              v
            http://127.0.0.1:4231/api/getprojects   (loopback-only, never public)
```

## Why raw Express middleware, not a NestJS controller?

A generated backend has its own, independent authentication system - it is not a BackOS
resource, and BackOS's own `JwtAuthGuard` / `PermissionsGuard` must **not** be applied to
traffic passing through to it (an anonymous visitor of a generated public API should not need a
BackOS account). Mounting this as `app.use(...)` middleware, ahead of `app.setGlobalPrefix('api')`
and Nest's router, is what makes that separation clean. The trade-off is that this path also
skips `ThrottlerGuard`, which is why `createGatewayRateLimiter()` exists as a dedicated
replacement scoped to just this path.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `GENERATED_BACKEND_HOST` | `127.0.0.1` | Loopback address generated backends bind to and the gateway proxies to. |
| `GENERATED_BACKEND_GATEWAY_PREFIX` | `/generated` | Public path prefix the gateway is mounted under. |

## Operational notes / future hardening

- **Horizontal scaling**: `createGatewayRateLimiter()` is a single-process, in-memory limiter.
  If BackOS is ever deployed across multiple instances, replace it with a Redis-backed limiter
  (Redis is already a dependency of this project for other features) so the limit is shared
  across instances.
- **Process isolation**: generated backends still run as plain OS processes via
  `child_process.spawn`, with no CPU/memory limits or filesystem sandboxing. The gateway and
  loopback-binding fixes in this change close the *network exposure* gap, but a compromised or
  runaway generated backend can still affect the host machine's resources. Consider running
  each generated backend inside its own container (e.g. via Docker, with resource limits) as a
  follow-up hardening step - see the audit report for more detail.
- **TLS**: this gateway itself does not terminate TLS; it assumes the parent BackOS process (or
  whatever sits in front of it, e.g. a load balancer) already handles HTTPS for the whole
  domain, generated backends included.
