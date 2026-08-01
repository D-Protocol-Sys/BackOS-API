import { Module } from '@nestjs/common';
import { GeneratorQueueModule } from './generator-queue.module';
import { ProvisioningService } from './provisioning.service';
import { SchemaBuilderService } from './schema-builder.service';
import { ProjectScaffolderService } from './project-scaffolder.service';
import { CrudGeneratorService } from './crud-generator.service';

@Module({

    imports: [GeneratorQueueModule],

    providers: [
        ProvisioningService,
        SchemaBuilderService,
        ProjectScaffolderService,
        CrudGeneratorService
    ],
    
    exports: [
        ProvisioningService,
        SchemaBuilderService,
        ProjectScaffolderService
    ],

})

export class GeneratorModule {}
