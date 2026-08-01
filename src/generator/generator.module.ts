import { Module } from '@nestjs/common';
import { GeneratorQueueModule } from './generator-queue.module';
import { ProvisioningService } from './provisioning.service';

@Module({

    imports: [GeneratorQueueModule],

    providers: [ProvisioningService],

    exports: [ProvisioningService],

})

export class GeneratorModule {}
