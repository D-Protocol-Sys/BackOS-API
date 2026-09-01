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
        RuntimeManagerService,
        // Registered but NOT injected anywhere yet - opt-in Docker isolation for generated
        // backends. See the class-level comment on DockerRuntimeManagerService for what it
        // takes to actually switch GeneratorController over to it (Docker must be available on
        // the host running this orchestrator).
        DockerRuntimeManagerService,
        ApiManifestService,
    ],
    
    exports: [
        ProvisioningService,
        SchemaBuilderService,
        ProjectScaffolderService,
        PortAllocatorService
    ],

})

export class GeneratorModule {}
