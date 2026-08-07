import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configuration } from './config';
import { validationSchema } from './config/env.validation';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { EmailModule } from './email/email.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { UsersModule } from './users/users.module';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { PermissionsModule } from './permissions/permissions.module';
import { RolesModule } from './roles/roles.module';
import { CommonModule } from './common/common.module';
import { ScheduleModule } from '@nestjs/schedule';
import { CleanupModule } from './cleanup/cleanup.module';
import { EntitiesModule } from './entities/entities.module';
import { FieldsModule } from './fields/fields.module';
import { GeneratorModule } from './generator/generator.module';
import { PlatformsModule } from './platforms/platforms.module';
import { ServiceCatalogModule } from './generator/service-catalog.module';
import { RelationsModule } from './relations/relations.module';
import { AuditModule } from './audit/audit.module';

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
            
        UsersModule,
            
        PermissionsModule,
            
        RolesModule,
        
        CommonModule,

        ScheduleModule.forRoot(),

        CleanupModule,

        PlatformsModule,

        EntitiesModule,

        FieldsModule,

        GeneratorModule,

        ServiceCatalogModule,

        RelationsModule,

        AuditModule

    ],

    controllers: [AppController],

    providers: [
        AppService,
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
    ],

})

export class AppModule {}
