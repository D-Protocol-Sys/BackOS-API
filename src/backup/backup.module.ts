import { Module } from '@nestjs/common';
import { BackupService } from './backup.service';
import { BackupController } from './backup.controller';
import { GeneratorModule } from '../generator/generator.module';

/**
 * Imports `GeneratorModule` purely to reuse the `ProvisioningService` it already exports (for
 * `getDecryptedConnectionUrl()`) - no need to re-register or duplicate that service's own
 * configuration here.
 */
@Module({
    imports: [GeneratorModule],
    controllers: [BackupController],
    providers: [BackupService],
})
export class BackupModule {}
