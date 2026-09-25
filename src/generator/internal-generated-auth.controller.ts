import { Body, Controller, Headers, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { InternalGeneratedAuthService } from './internal-generated-auth.service';
import { VerifyInternalLoginDto } from './dto/verify-internal-login.dto';
import { SessionCheckDto } from './dto/session-check.dto';

/**
 * Machine-to-machine endpoints called by GENERATED BACKENDS (never by a browser) so that the
 * "internal login" of their Auth & User service - BackOS username + authenticator code - is
 * verified by BackOS, the only place that holds the TOTP secrets.
 *
 * Marked `@Public()` because there is no BackOS user session here: the caller is authenticated by
 * the `X-Backos-Platform-Id` + `X-Backos-Internal-Key` header pair instead (see
 * `InternalGeneratedAuthService`). Hidden from the Swagger document.
 */
@ApiExcludeController()
@Controller('internal/generated-auth')
export class InternalGeneratedAuthController {
    constructor(private readonly internalAuth: InternalGeneratedAuthService) {}

    @Public()
    @Post('verify')
    @HttpCode(HttpStatus.OK)
    verify(
        @Headers('x-backos-platform-id') platformId: string | undefined,
        @Headers('x-backos-internal-key') internalKey: string | undefined,
        @Body() dto: VerifyInternalLoginDto,
        @Req() req: Request,
    ) {
        return this.internalAuth.verify(platformId, internalKey, dto.userId, dto.totpCode, {
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'],
        });
    }

    @Public()
    @Post('session-check')
    @HttpCode(HttpStatus.OK)
    sessionCheck(
        @Headers('x-backos-platform-id') platformId: string | undefined,
        @Headers('x-backos-internal-key') internalKey: string | undefined,
        @Body() dto: SessionCheckDto,
    ) {
        return this.internalAuth.sessionCheck(platformId, internalKey, dto.userId);
    }
}
