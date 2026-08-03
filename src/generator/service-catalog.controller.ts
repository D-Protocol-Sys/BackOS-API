import { Controller, Get } from '@nestjs/common';
import { ServiceCatalog } from './service-catalog/service-catalog';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('Service Catalog')
@ApiBearerAuth('access-token')
@Controller('service-catalog')
export class ServiceCatalogController {

    constructor(private readonly catalog: ServiceCatalog) {}

    @Get()
    list() {
        return this.catalog.list();
    }

}