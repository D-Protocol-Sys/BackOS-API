import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
    constructor(private readonly authService: AuthService) {}

    @Public()
    @Throttle({ default: { limit: 3, ttl: 600_000 } })
    @Post('otp/request')
    requestOtp(@Body() dto: RequestOtpDto) {
        return this.authService.requestOtp(dto);
    }

    @Public()
    @Throttle({ default: { limit: 10, ttl: 600_000 } })
    @Post('otp/verify')
    verifyOtp(@Body() dto: VerifyOtpDto) {
        return this.authService.verifyOtp(dto);
    }

    @Public()
    @Post('refresh')
    refresh(@Body() dto: RefreshTokenDto) {
        return this.authService.refreshTokens(dto.refreshToken);
    }

    @Post('logout')
    logout(
        @CurrentUser() user: { userId: string },
        @Body() dto: RefreshTokenDto,
    ) {
        return this.authService.logout(user.userId, dto.refreshToken);
    }

}
