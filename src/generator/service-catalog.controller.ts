import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ServiceCatalog } from './service-catalog/service-catalog';

/**
    * Exposes endpoints to query the system's available service catalog.
    * Educational Note: Decorating the entire controller with `@ApiBearerAuth` enforces 
    * JWT documentation across all routes inside this controller in Swagger UI.
    */
@ApiTags('Service Catalog')
@ApiBearerAuth('access-token')
@Controller('service-catalog')
export class ServiceCatalogController {
    constructor(private readonly catalog: ServiceCatalog) {}

    /**
     * Retrieves the list of active services from the catalog.
     */
    @Get()
    list() {
        return this.catalog.list();
    }
}