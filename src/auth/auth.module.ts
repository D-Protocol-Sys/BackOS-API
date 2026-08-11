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
import { CryptoService } from '../common/services/crypto.service';

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
        CryptoService
    ],

    exports: [AuthService],

})

export class AuthModule {}
