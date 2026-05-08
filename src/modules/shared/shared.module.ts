import { Module } from '@nestjs/common';

import { ApiConfigService } from './services/api-config.service';
import { SnsService } from './services/sns.service';
import { SolanaService } from './services/solana.service';

@Module({
  providers: [ApiConfigService, SolanaService, SnsService],
  exports: [ApiConfigService, SolanaService, SnsService],
})
export class SharedModule {}
