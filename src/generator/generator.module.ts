import { Module } from '@nestjs/common';
import { GeneratorQueueModule } from './generator-queue.module';
import { ProvisioningService } from './provisioning.service';
import { SchemaBuilderService } from './schema-builder.service';
import { ProjectScaffolderService } from './project-scaffolder.service';
import { CrudGeneratorService } from './crud-generator.service';
import { GenerationProcessor } from './generation.processor';
import { GenerationsService } from './generations.service';
import { ServiceCatalogModule } from './service-catalog.module';
import { GeneratorController } from './generator.controller';
import { PortAllocatorService } from './port-allocator.service';
import { GenerationCancellationRegistry } from './generation-cancellation.registry';
import { DockerRuntimeManagerService } from './docker-runtime-manager.service';
import { ApiManifestService } from './api-manifest.service';
import { AuthModule } from '../auth/auth.module';
import { InternalGeneratedAuthController } from './internal-generated-auth.controller';
import { InternalGeneratedAuthService } from './internal-generated-auth.service';
import { PlatformAccessModule } from '../platforms/platform-access.module';
import { InternalAccountsSyncService } from './internal-accounts-sync.service';
import { RuntimeRecoveryService } from './runtime-recovery.service';

@Module({
    imports: [
        GeneratorQueueModule,
        ServiceCatalogModule,
        // Provides AuthService, used by InternalGeneratedAuthService to verify the authenticator
        // code of a person logging in to a generated backend.
        AuthModule,
        // Shared "who can do what on this platform" resolver (see PlatformAccessModule for why
        // it is a standalone module rather than coming from PlatformsModule).
        PlatformAccessModule,
    ],

    controllers: [GeneratorController, InternalGeneratedAuthController],

    providers: [
        ProvisioningService,
        SchemaBuilderService,
        ProjectScaffolderService,
        InternalAccountsSyncService,
        CrudGeneratorService,
        GenerationsService,
        PortAllocatorService,
        GenerationProcessor,
        GenerationCancellationRegistry,
        // ARCH-005: the unused native-process RuntimeManagerService was removed - every runtime
        // route goes through the Docker-based implementation below.
        DockerRuntimeManagerService,
        // Restarts the generated backends that were running before a host / Docker restart.
        RuntimeRecoveryService,
        ApiManifestService,
        InternalGeneratedAuthService,
    ],

    exports: [
        ProvisioningService,
        SchemaBuilderService,
        ProjectScaffolderService,
        PortAllocatorService,
        // Exported so PlatformsModule can tell a running generated backend to resync its internal
        // accounts whenever a member / role changes (see InternalAccountsSyncService).
        InternalAccountsSyncService,
        // Exported so PlatformsModule can stop a platform's runtime as part of archiving it,
        // and remove its on-disk generated project directory as part of permanently deleting
        // it - see PlatformsService.archive()/purge().
        DockerRuntimeManagerService,
    ],
})
export class GeneratorModule {}
