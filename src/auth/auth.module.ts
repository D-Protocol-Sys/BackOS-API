import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import type { StringValue } from 'ms';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { RecoveryCodeService } from '../common/utils/recovery-code.service';
import { MfaService } from '../common/services/mfa.service';
import { TotpService } from '../common/utils/totp.service';
import { QrCodeService } from '../common/utils/qr-code.service';
// NOTE: CryptoService is no longer listed as a provider here - it now lives in the global
// `CommonModule` (see that module's header comment), since `ProvisioningService` and
// `PlatformServicesService` need it too and neither imports `AuthModule`. `MfaService` below
// still receives it via the same dependency-injection token, just resolved from the global
// module instead of this one - no behavioural change for anything in this module.

@Module({

    imports: [

        PassportModule,
        JwtModule.registerAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (configService: ConfigService) => ({
                secret: configService.getOrThrow<string>('jwt.secret'),
                signOptions: {
                    expiresIn: configService.getOrThrow<StringValue>('jwt.expiresIn'),
                },
            }),
        }),
    ],

    controllers: [AuthController],

    providers: [
        AuthService,
        JwtStrategy,
        RecoveryCodeService,
        MfaService,
        TotpService,
        QrCodeService,
    ],

    exports: [AuthService],

})

export class AuthModule {}
