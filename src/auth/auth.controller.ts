import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { AuthService } from './auth.service';
import { ValidateInvitationDto } from './dto/validate-invitation.dto';
import { ConsumeInvitationDto } from './dto/consume-invitation.dto';
import { ConfirmMfaDto } from './dto/confirm-mfa.dto';
import { LoginDto } from './dto/login.dto';
import { RecoveryLoginDto } from './dto/recovery-login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';

import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

/**
 * Helper function to extract request metadata (IP address and User-Agent) 
 * for security auditing and session context tracking.
 * * @param req - Express Request object
 * @returns An object containing ipAddress and userAgent
 */
function extractContext(req: Request) {
    return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

/**
 * Controller handling user authentication, invitation flows, MFA management, 
 * and session token lifecycles.
 */
@ApiTags('Auth')
@Controller('auth')
export class AuthController {
    constructor(private readonly authService: AuthService) {}

    /**
     * Validates an invitation token before consuming it.
     */
    @Public()
    @Post('invitation/validate-token')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Validate an invitation token' })
    @ApiOkResponse({ description: 'Invitation token is valid and returns user identity details.' })
    validateToken(@Body() dto: ValidateInvitationDto) {
        return this.authService.validateInvitationToken(dto);
    }

    /**
     * Consumes an invitation token and initial verification code to begin onboarding.
     */
    @Public()
    @Post('invitation/consume')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Consume an invitation link and verification code' })
    @ApiOkResponse({ description: 'Invitation consumed successfully. Returns initial setup setup context/secret.' })
    consumeInvitation(@Body() dto: ConsumeInvitationDto, @Req() req: Request) {
        return this.authService.consumeInvitation(dto, extractContext(req));
    }

    /**
     * Confirms and finalizes Multi-Factor Authentication (MFA) setup.
     */
    @Public()
    @Post('mfa/confirm')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Confirm MFA setup and activate account' })
    @ApiOkResponse({ description: 'MFA setup confirmed successfully. Account is fully activated.' })
    confirmMfa(@Body() dto: ConfirmMfaDto, @Req() req: Request) {
        return this.authService.confirmMfa(dto, extractContext(req));
    }

    /**
     * Authenticates a user using their credentials and TOTP code.
     */
    @Public()
    @Post('login')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Authenticate user with credentials and TOTP' })
    @ApiOkResponse({ description: 'User authenticated successfully. Returns JWT access and refresh tokens.' })
    login(@Body() dto: LoginDto, @Req() req: Request) {
        return this.authService.login(dto, extractContext(req));
    }

    /**
     * Authenticates a user using a emergency recovery code when TOTP is unavailable.
     */
    @Public()
    @Post('login/recovery')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Authenticate user using a backup recovery code' })
    @ApiOkResponse({ description: 'User authenticated via recovery code. Returns JWT access and refresh tokens.' })
    loginWithRecovery(@Body() dto: RecoveryLoginDto, @Req() req: Request) {
        return this.authService.loginWithRecoveryCode(dto, extractContext(req));
    }

    /**
     * Renews an expired access token using a valid refresh token.
     */
    @Public()
    @Post('refresh')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Refresh JWT access token' })
    @ApiOkResponse({ description: 'Tokens refreshed successfully. Returns new access and refresh tokens.' })
    refresh(@Body() dto: RefreshTokenDto) {
        return this.authService.refreshTokens(dto.refreshToken);
    }

    /**
     * Logs out the user and invalidates the active refresh token session.
     */
    @ApiBearerAuth('access-token')
    @Post('logout')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Log out current user session' })
    @ApiOkResponse({ description: 'Logged out successfully. Refresh token invalidated.' })
    logout(
        @CurrentUser() user: { userId: string }, 
        @Body() dto: RefreshTokenDto,
    ) {
        return this.authService.logout(user.userId, dto.refreshToken);
    }
}