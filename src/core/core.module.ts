import { Global, Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { VerticalPolicyService } from './verticals/vertical-policy.service';

@Global()
@Module({
  imports: [CacheModule.register()],
  providers: [VerticalPolicyService],
  exports: [VerticalPolicyService],
})
export class CoreModule {}
