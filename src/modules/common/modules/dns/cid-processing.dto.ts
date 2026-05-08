import type { CidProcessingEntity } from '../../../dns/cid-processing/cid-processing.entity';
import { AbstractDto } from '../../dtoes/abstract.dto';

export class CidProcessingDto extends AbstractDto {
  cid: string;

  primaryDnsId: string;

  isProcessed: boolean;

  associatedDomains: string[];

  constructor(cidProcessing: CidProcessingEntity) {
    super(cidProcessing);

    this.cid = cidProcessing.cid;
    this.primaryDnsId = cidProcessing.primaryDnsId;
    this.isProcessed = cidProcessing.isProcessed;
    this.associatedDomains = cidProcessing.associatedDomains;
  }
}
