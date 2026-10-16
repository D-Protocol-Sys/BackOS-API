import { Module } from '@nestjs/common';
import { CleanupService } from './cleanup.service';
import { PlatformsModule } from '../platforms/platforms.module';
import { ClientsModule } from '../clients/clients.module';

@Module({
    // PlatformsModule for PlatformsService.purgeExpiredArchives() - purging an archived
    // platform has side effects beyond the database (stopping its runtime, deleting its
    // generated files), so that logic lives in PlatformsService rather than being duplicated
    // here as a plain Prisma deleteMany like this service's other cleanup subroutines.
    // ClientsModule for the same reason: ClientsService.purgeExpiredArchives()/
    // purgeExpiredContractArchives() purge attached files via FilesService as part of purging
    // a client/contract.
    imports: [PlatformsModule, ClientsModule],

    providers: [CleanupService],
})
export class CleanupModule {}
