import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configuration } from './config';
import { validationSchema } from './config/env.validation';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
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
import { EnumDefinitionsModule } from './enum-definitions/enum-definitions.module';
import { GeneratorModule } from './generator/generator.module';
import { PlatformsModule } from './platforms/platforms.module';
import { ProjectsModule } from './projects/projects.module';
import { ServiceCatalogModule } from './generator/service-catalog.module';
import { RelationsModule } from './relations/relations.module';
import { AuditModule } from './audit/audit.module';
import { PlanningModule } from './planning/planning.module';
import { FilesModule } from './files/files.module';
import { TrackActivityInterceptor } from './common/interceptors/track-activity.interceptor';
import { MessagesModule } from './messages/messages.module';
import { ProvisioningHealthService } from './common/services/provisioning-health.service';
import { GatewayModule } from './gateway/gateway.module';
import { BackupModule } from './backup/backup.module';
import { ClientsModule } from './clients/clients.module';

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

        // RATE LIMITING FIX: `ThrottlerModule.forRoot()` only registers the throttler's
        // storage/default config - it does NOT, by itself, apply rate limiting to any route.
        // It used to be paired with a global `APP_GUARD` below (removed - see the comment
        // that used to sit next to it), which shared this single 20 req/min budget across
        // EVERY endpoint of the whole API: the dashboard alone (platforms list + entities +
        // fields + generation status polling...) could burn through that budget in a few
        // seconds of normal use, which is exactly what was producing frequent "Too many
        // requests" errors during ordinary usage, not abuse.
        //
        // Rate limiting is still very much in effect - just scoped to where it actually
        // matters, via `@UseGuards(ThrottlerGuard)` + `@Throttle(...)` placed directly on the
        // sensitive/expensive routes that deserve their own budget:
        //   - AuthController      (login, recovery, MFA, invitation flows - credential guessing)
        //   - GeneratorController (POST .../generate, runtime/start, runtime/stop - spawn
        //                          real OS processes / expensive background jobs)
        //   - FilesController     (file uploads - disk I/O and storage cost)
        // Every other route (GET lists, polling endpoints, etc.) is no longer throttled at
        // all, which is what normal, legitimate traffic needs.
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 20 }]),
            
        PrismaModule,
            
        EmailModule,
            
        AuthModule,
            
        UsersModule,
            
        PermissionsModule,
            
        RolesModule,
        
        CommonModule,

        // Global module resolving generated-platform slugs to their internal loopback
        // address, and invalidated by RuntimeManagerService on every runtime state change.
        // See src/gateway/GATEWAY_README.md.
        GatewayModule,

        ScheduleModule.forRoot(),

        CleanupModule,

        PlatformsModule,

        ProjectsModule,

        EntitiesModule,

        FieldsModule,
        EnumDefinitionsModule,

        GeneratorModule,

        ServiceCatalogModule,

        RelationsModule,

        PlanningModule,

        FilesModule,

        MessagesModule,

        ClientsModule,

        AuditModule,

        BackupModule,

    ],

    controllers: [AppController],

    providers: [
        AppService,
        ProvisioningHealthService,
        // NOTE: ThrottlerGuard is intentionally NOT registered globally here anymore - see
        // the long comment on `ThrottlerModule.forRoot(...)` above for why. It is applied
        // locally, via `@UseGuards(ThrottlerGuard)`, only on the specific controllers/routes
        // that need their own request budget.
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_INTERCEPTOR, useClass: TrackActivityInterceptor },
    ],

})

export class AppModule {}
