import { Column, Entity, Index, OneToMany } from 'typeorm';

import { DnsTypeEnum } from '../../constants/chain.enum';
import { AbstractEntity } from '../common/entities/abstract.entity';
import { EnsResolverDto } from '../common/modules/shared/ens-resolver.dto';
import { DnsEntity } from './dns.entity';

@Entity('ens_resolvers')
export class EnsResolverEntity extends AbstractEntity<EnsResolverDto> {
  @Column({ unique: true })
  address: string;

  @Column({ nullable: true })
  txHash?: string;

  @Column({ type: 'enum', enum: DnsTypeEnum, default: DnsTypeEnum.ENS })
  @Index()
  type: DnsTypeEnum;

  @OneToMany(() => DnsEntity, (dnsEntity) => dnsEntity.ensResolver)
  dnses: DnsEntity[];

  dtoClass = EnsResolverDto;
}
