import { Module } from '@nestjs/common';
import { CleanupService } from './cleanup.service';
import { PlatformsModule } from '../platforms/platforms.module';

@Module({

    // PlatformsModule for PlatformsService.purgeExpiredArchives() - purging an archived
    // platform has side effects beyond the database (stopping its runtime, deleting its
    // generated files), so that logic lives in PlatformsService rather than being duplicated
    // here as a plain Prisma deleteMany like this service's other cleanup subroutines.
    imports: [PlatformsModule],

    providers: [CleanupService],
    
})

export class CleanupModule {}
