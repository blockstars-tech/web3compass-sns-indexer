import type { DnsTypeEnum } from '../../../../constants/chain.enum';
import type { EnsResolverEntity } from '../../../dns/ens-resolver.entity';
import { AbstractDto } from '../../dtoes/abstract.dto';

export class EnsResolverDto extends AbstractDto {
  address: string;

  txHash?: string;

  type: DnsTypeEnum;

  constructor(ensResolverEntity: EnsResolverEntity) {
    super(ensResolverEntity);

    this.address = ensResolverEntity.address;
    this.txHash = ensResolverEntity.txHash;
    this.type = ensResolverEntity.type;
  }
}
