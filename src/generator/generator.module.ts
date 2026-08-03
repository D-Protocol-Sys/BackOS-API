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
    ],
    
    exports: [
        ProvisioningService,
        SchemaBuilderService,
        ProjectScaffolderService,
        PortAllocatorService
    ],

})

export class GeneratorModule {}
