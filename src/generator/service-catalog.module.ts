import { Module } from '@nestjs/common';
import { ServiceCatalog } from './service-catalog/service-catalog';
import { PlatformServicesService } from './platform-services.service';
import { ServiceCatalogController } from './service-catalog.controller';
import { PlatformServicesController } from './platform-services.controller';
import { PlatformAccessModule } from '../platforms/platform-access.module';

@Module({
    imports: [PlatformAccessModule],

    controllers: [ServiceCatalogController, PlatformServicesController],

    providers: [ServiceCatalog, PlatformServicesService],

    exports: [ServiceCatalog, PlatformServicesService],
})
export class ServiceCatalogModule {}
