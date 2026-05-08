import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { DnsSettingsEntity } from '../../../dns/dns-settings.entity';
import { AbstractDto } from '../../dtoes/abstract.dto';

export class DnsSettingsDto extends AbstractDto {
  @ApiProperty()
  txHash: string;

  @ApiPropertyOptional()
  cid?: string;

  @ApiPropertyOptional()
  logoUrl?: string;

  @ApiPropertyOptional()
  ipfsUrl?: string;

  constructor(dnsSettings: DnsSettingsEntity) {
    super(dnsSettings);

    this.txHash = dnsSettings.txHash;
    this.cid = dnsSettings.cid;
    this.logoUrl = dnsSettings.logoUrl;
    this.ipfsUrl = dnsSettings.ipfsUrl;
  }
}
