import { Global, Module } from '@nestjs/common';
import { PlatformGatewayService } from './platform-gateway.service';

/**
 * Groups everything related to routing public traffic for
 * `https://<your-domain>/generated/<slug>/...` to the correct generated backend process.
 *
 * Marked `@Global()` (consistent with `PrismaModule` and `CommonModule` in this codebase) so
 * that `RuntimeManagerService` (in `GeneratorModule`) can inject `PlatformGatewayService`
 * without a direct module import cycle between `GeneratorModule` and `GatewayModule`.
 *
 * The actual HTTP proxying middleware (`createGeneratedBackendProxyMiddleware`) is wired up in
 * `main.ts` via `app.use(...)`, rather than as a NestJS controller - see the comment on that
 * function, and `GATEWAY_README.md`, for why it deliberately sits outside Nest's normal
 * routing/guard pipeline.
 */
@Global()
@Module({
    providers: [PlatformGatewayService],
    exports: [PlatformGatewayService],
})
export class GatewayModule {}
