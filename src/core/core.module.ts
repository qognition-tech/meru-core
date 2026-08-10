import { Global, Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { VerticalPolicyService } from './verticals/vertical-policy.service';

@Global()
@Module({
  imports: [CacheModule.register()],
  providers: [VerticalPolicyService],
  // CacheModule is re-exported so `CACHE_MANAGER` is injectable anywhere,
  // through this module's @Global registration. Importing
  // `CacheModule.register()` per module would work too and would give each one
  // its own isolated store — which for a cache keyed on session revocation
  // means a logout invalidated in one module's store and still live in
  // another's.
  exports: [VerticalPolicyService, CacheModule],
})
export class CoreModule {}
