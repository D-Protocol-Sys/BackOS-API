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
import { RuntimeManagerService } from './runtime-manager.service';
import { DockerRuntimeManagerService } from './docker-runtime-manager.service';
import { ApiManifestService } from './api-manifest.service';

@Module({

    imports: [
        GeneratorQueueModule,
        ServiceCatalogModule
    ],

    controllers: [GeneratorController],

    providers: [
        ProvisioningService,
        SchemaBuilderService,
        ProjectScaffolderService,
        CrudGeneratorService,
        GenerationsService,
        PortAllocatorService,
        GenerationProcessor,
        GenerationCancellationRegistry,
        // NOTE: this comment previously read "registered but not injected anywhere yet" - that
        // is no longer accurate. GeneratorController's runtime/start, runtime/stop, runtime/
        // status and runtime/logs routes are wired directly to DockerRuntimeManagerService
        // below, not to this native-process implementation. RuntimeManagerService is kept
        // registered for local/no-Docker setups that still construct it directly, but nothing
        // in this module currently routes traffic to it.
        RuntimeManagerService,
        DockerRuntimeManagerService,
        ApiManifestService,
    ],
    
    exports: [
        ProvisioningService,
        SchemaBuilderService,
        ProjectScaffolderService,
        PortAllocatorService,
        // Exported so PlatformsModule can stop a platform's runtime as part of archiving it,
        // and remove its on-disk generated project directory as part of permanently deleting
        // it - see PlatformsService.archive()/purge().
        DockerRuntimeManagerService,
    ],

})

export class GeneratorModule {}
