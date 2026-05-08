import { Repository } from 'typeorm';

import { ChainEnum } from '../../constants/chain.enum';
import { MigrationTypeEnum } from '../../constants/migration-type.enum';
import { CustomRepository } from '../../db/typeorm-ex.decorator';
import { DnsMigrationEntity } from './dns-migration.entity';

@CustomRepository(DnsMigrationEntity)
export class DnsMigrationRepository extends Repository<DnsMigrationEntity> {
  async findSnsRegisterMigration(): Promise<DnsMigrationEntity | null> {
    return this.createQueryBuilder('info')
      .where('info.type = :type', { type: MigrationTypeEnum.SNS_REGISTER })
      .getOne();
  }

  async findSnsRecordsV2UpdateMigration(): Promise<DnsMigrationEntity | null> {
    return this.createQueryBuilder('info')
      .where('info.type = :type', {
        type: MigrationTypeEnum.SNS_RECORDS_V2_UPDATE,
      })
      .getOne();
  }

  async findSnsBackfillMigration(): Promise<DnsMigrationEntity | null> {
    return this.createQueryBuilder('info')
      .where('info.type = :type', { type: MigrationTypeEnum.SNS_BACKFILL })
      .getOne();
  }

  async getSnsRegisterMigrationInfo(): Promise<{
    lastMigratedBlockNumber: number;
    isMigrated: boolean;
  }> {
    const data = await this.findSnsRegisterMigration();

    return {
      lastMigratedBlockNumber: data?.lastMigratedBlockNumber || 0,
      isMigrated: data?.isMigrated || false,
    };
  }

  async getSnsRecordsV2UpdateMigrationInfo(): Promise<{
    lastMigratedBlockNumber: number;
  }> {
    const data = await this.findSnsRecordsV2UpdateMigration();

    return {
      lastMigratedBlockNumber: data?.lastMigratedBlockNumber || 0,
    };
  }

  async getSnsBackfillMigrationInfo(): Promise<{
    lastMigratedBlockNumber: number;
    isMigrated: boolean;
  }> {
    const data = await this.findSnsBackfillMigration();

    return {
      lastMigratedBlockNumber: data?.lastMigratedBlockNumber || 0,
      isMigrated: data?.isMigrated || false,
    };
  }

  async saveSnsRegisterMigration(options: {
    lastBlock: number;
    isMigrated?: boolean;
  }): Promise<DnsMigrationEntity> {
    let row = await this.findSnsRegisterMigration();

    if (!row) {
      row = this.create({
        type: MigrationTypeEnum.SNS_REGISTER,
        lastMigratedBlockNumber: options.lastBlock,
        chain: ChainEnum.SOLANA,
      });
    } else {
      row.lastMigratedBlockNumber = options.lastBlock;
    }

    if (options.isMigrated !== undefined) {
      row.isMigrated = options.isMigrated;
    }

    return this.save(row);
  }

  async saveSnsRecordsV2UpdateMigration(options: {
    lastBlock: number;
  }): Promise<DnsMigrationEntity> {
    let row = await this.findSnsRecordsV2UpdateMigration();

    if (!row) {
      row = this.create({
        type: MigrationTypeEnum.SNS_RECORDS_V2_UPDATE,
        lastMigratedBlockNumber: options.lastBlock,
        chain: ChainEnum.SOLANA,
      });
    } else {
      row.lastMigratedBlockNumber = options.lastBlock;
    }

    return this.save(row);
  }

  async saveSnsBackfillMigration(options: {
    lastBlock: number;
    isMigrated?: boolean;
  }): Promise<DnsMigrationEntity> {
    let row = await this.findSnsBackfillMigration();

    if (!row) {
      row = this.create({
        type: MigrationTypeEnum.SNS_BACKFILL,
        lastMigratedBlockNumber: options.lastBlock,
        chain: ChainEnum.SOLANA,
      });
    } else {
      row.lastMigratedBlockNumber = options.lastBlock;
    }

    if (options.isMigrated !== undefined) {
      row.isMigrated = options.isMigrated;
    }

    return this.save(row);
  }
}
