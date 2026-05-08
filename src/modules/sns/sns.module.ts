import { Module } from '@nestjs/common';

import { TypeOrmExModule } from '../../db/typeorm-ex.module';
import { CidProcessingRepository } from '../dns/cid-processing/cid-processing.repository';
import { CidProcessingService } from '../dns/cid-processing/cid-processing.service';
import { DnsRepository } from '../dns/dns.repository';
import { DnsMigrationRepository } from '../dns/dns-migration.repository';
import { DnsSettingsRepository } from '../dns/dns-settings.repository';
import { DnsSettingsService } from '../dns/dns-settings.service';
import { PointerModule } from '../pointer/pointer.module';
import { SharedModule } from '../shared/shared.module';
import { SnsBackfillJob } from './jobs/sns-backfill.job';
import { SnsReconcileJob } from './jobs/sns-reconcile.job';
import { SnsRecordChangesJob } from './jobs/sns-record-changes.job';
import { SnsRegisterJob } from './jobs/sns-register.job';

@Module({
  imports: [
    TypeOrmExModule.forCustomRepository([
      DnsRepository,
      DnsMigrationRepository,
      DnsSettingsRepository,
      CidProcessingRepository,
    ]),
    PointerModule,
    SharedModule,
  ],
  providers: [
    DnsSettingsService,
    CidProcessingService,
    SnsRegisterJob,
    SnsRecordChangesJob,
    SnsReconcileJob,
    SnsBackfillJob,
  ],
  exports: [],
})
export class SnsModule {}
