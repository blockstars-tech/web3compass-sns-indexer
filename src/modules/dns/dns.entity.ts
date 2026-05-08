import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
} from 'typeorm';

import { ChainEnum } from '../../constants/chain.enum';
import { AbstractEntity } from '../common/entities/abstract.entity';
import { DnsDto } from '../common/modules/dns/dns.dto';
import { DnsSettingsEntity } from './dns-settings.entity';
import { EnsResolverEntity } from './ens-resolver.entity';
import { UrlEntity } from './url.entity';

@Entity({ name: 'dns' })
export class DnsEntity extends AbstractEntity<DnsDto> {
  @Column()
  @Index({ unique: true })
  name: string;

  @Column({ nullable: true })
  @Index()
  node?: string;

  @Column({ nullable: true })
  cid?: string;

  @Column({ nullable: true })
  contentType?: string;

  @Column({ nullable: true })
  setupTxHash?: string;

  @Column({ nullable: true })
  isMigrationFixed?: number;

  @Column({
    nullable: true,
    comment: 'To track the status of IPFS fetch 1 = failed, 0 = success',
  })
  @Index()
  ipfsFetchStatus?: number;

  @Column({ default: 0 })
  @Index()
  ipfsFetchAttempt: number;

  @Column({ nullable: true })
  @Index()
  isFetchFailed?: boolean;

  @Column({ nullable: true })
  logoUrl?: string;

  @Column({ nullable: true })
  tokenId?: string;

  @Column({ nullable: true })
  ownerAddress?: string;

  @Column({ nullable: true })
  address?: string;

  @Column({ nullable: true })
  main?: string;

  @Column({ nullable: true })
  isFixed?: boolean;

  @Column({ nullable: true })
  hasSite?: boolean;

  @Column({ nullable: true })
  ensResolverId?: string;

  @Column({ type: 'enum', enum: ChainEnum, default: ChainEnum.ETH })
  chain: ChainEnum;

  @OneToMany(() => UrlEntity, (urlEntity) => urlEntity.dns)
  urls: UrlEntity[];

  @ManyToOne(
    () => EnsResolverEntity,
    (ensResolverEntity) => ensResolverEntity.dnses,
    {
      nullable: true,
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },
  )
  @JoinColumn({ name: 'ens_resolver_id' })
  ensResolver?: EnsResolverEntity;

  @OneToMany(
    () => DnsSettingsEntity,
    (dnsSettingsEntity) => dnsSettingsEntity.dns,
  )
  settings: DnsSettingsEntity[];

  @Column({ default: 0, comment: 'To track the number of retry attempts' })
  @Index()
  attempt: number;

  @Column({
    nullable: true,
    comment: 'To track if IPFS processing has been attempted',
  })
  @Index()
  ipfsProcessed: boolean;

  @Column({
    nullable: true,
  })
  expiresAt?: Date;

  @Column({
    default: false,
    comment: 'To track if it should be re-indexed',
  })
  @Index()
  needsReindex: boolean;

  @Column({ nullable: true })
  @Index()
  cidProcessingId?: string;

  @Column({ default: false })
  @Index()
  isPrimary: boolean;

  dtoClass = DnsDto;
}
