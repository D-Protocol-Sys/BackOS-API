import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configuration } from './config';
import { validationSchema } from './config/env.validation';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
// import { AppController } from './app.controller';
// import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { EmailModule } from './email/email.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';

@Module({

  imports: [

    ConfigModule.forRoot({
      isGlobal: true,

      cache: true,

      load: configuration,

      validationSchema,

      validationOptions: {
        abortEarly: false,
      },

      expandVariables: true,

      envFilePath: `.env.${process.env.NODE_ENV ?? 'development'}`,

      ignoreEnvFile: process.env.NODE_ENV === 'production',
    }),

    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 20 }]),
    PrismaModule,
    EmailModule,
    AuthModule,
  ],

  controllers: [],

  providers: [
    // AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],

})

export class AppModule {}
