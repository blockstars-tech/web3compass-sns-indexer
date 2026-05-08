import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { AbstractEntity } from '../../common/entities/abstract.entity';
import { CidProcessingDto } from '../../common/modules/dns/cid-processing.dto';
import { DnsEntity } from '../dns.entity';

@Entity('cid_processing')
export class CidProcessingEntity extends AbstractEntity<CidProcessingDto> {
  @Column({ unique: true })
  @Index()
  cid: string;

  @Column('uuid')
  @Index()
  primaryDnsId: string;

  @Column({ default: false })
  @Index()
  isProcessed: boolean;

  @Column('text', { array: true })
  associatedDomains?: string[];

  @Column({ default: false })
  hasSite: boolean;

  @ManyToOne(() => DnsEntity)
  @JoinColumn({ name: 'primary_dns_id' })
  primaryDns: DnsEntity;

  dtoClass = CidProcessingDto;
}
