import { Column, Entity } from 'typeorm';

import { ChainEnum } from '../../constants/chain.enum';
import { MigrationTypeEnum } from '../../constants/migration-type.enum';
import { AbstractEntity } from '../common/entities/abstract.entity';
import { DnsMigrationDto } from '../common/modules/dns/dns-migration.dto';

@Entity({ name: 'dns_migrations' })
export class DnsMigrationEntity extends AbstractEntity<DnsMigrationDto> {
  @Column({
    type: 'enum',
    enum: MigrationTypeEnum,
    default: MigrationTypeEnum.DEFAULT,
    nullable: true,
  })
  type?: MigrationTypeEnum;

  @Column()
  lastMigratedBlockNumber: number;

  @Column({ type: 'boolean', default: false })
  isMigrated: boolean;

  @Column({ type: 'enum', enum: ChainEnum, default: ChainEnum.ETH })
  chain: ChainEnum;

  dtoClass = DnsMigrationDto;
}
