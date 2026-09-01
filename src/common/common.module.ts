import { Global, Module } from '@nestjs/common';
import { RoleHierarchyService } from './services/role-hierarchy.service';
import { CryptoService } from './services/crypto.service';

/**
 * `CryptoService` lives here (rather than only inside `AuthModule`'s own providers) so it can
 * be injected anywhere in the application without every consuming module needing to import
 * `AuthModule` just to reach it. `ProvisioningService` and `PlatformServicesService` (in
 * `GeneratorModule`) depend on it too, after the encryption-utility consolidation - see the
 * header comment on `CryptoService` for why two encryption schemes live on one class.
 */
@Global()
@Module({

    providers: [RoleHierarchyService, CryptoService],

    exports: [RoleHierarchyService, CryptoService],

})

export class CommonModule {}
