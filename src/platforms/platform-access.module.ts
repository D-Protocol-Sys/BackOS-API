import { Module } from '@nestjs/common';
import { PlatformAccessService } from './platform-access.service';

/**
 * Kept separate from `PlatformsModule` deliberately: `PlatformsModule` already imports
 * `GeneratorModule`, so if `GeneratorController` also needed `PlatformsModule` (for
 * `PlatformAccessService`) that would be a circular module dependency. This tiny module depends
 * on nothing but the (global) `PrismaModule`, so both `PlatformsModule`, `GeneratorModule` and
 * `UsersModule` can import it freely.
 */
@Module({
    providers: [PlatformAccessService],
    exports: [PlatformAccessService],
})
export class PlatformAccessModule {}
