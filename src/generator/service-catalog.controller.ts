import { Controller, Get } from '@nestjs/common';
import { ServiceCatalog } from './service-catalog/service-catalog';

@Controller('service-catalog')
export class ServiceCatalogController {

    constructor(private readonly catalog: ServiceCatalog) {}

    @Get()
    list() {
        return this.catalog.list();
    }

}