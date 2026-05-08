import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

import { ChainEnum } from "../../../../constants/chain.enum";
import type { DnsEntity } from "../../../dns/dns.entity";
import { AbstractDto } from "../../dtoes/abstract.dto";
import type { EnsResolverDto } from "../shared/ens-resolver.dto";
import type { UrlDto } from "./url.dto";

export class DnsDto extends AbstractDto {
  @ApiProperty()
  name: string;

  @ApiProperty()
  chain?: ChainEnum;

  @ApiPropertyOptional()
  node?: string;

  @ApiPropertyOptional()
  setupTxHash?: string;

  @ApiPropertyOptional()
  logoUrl?: string;

  @ApiPropertyOptional()
  scannerUrl?: string;

  @ApiPropertyOptional()
  address?: string;

  @ApiProperty()
  cid?: string;

  // @ApiProperty()
  contentType?: string;

  @ApiProperty()
  tokenId?: string;

  @ApiPropertyOptional()
  urls?: UrlDto[];

  @ApiPropertyOptional()
  hasSite?: boolean;

  @ApiPropertyOptional()
  main?: string;

  @ApiPropertyOptional()
  expiresAt?: Date;

  @ApiPropertyOptional()
  ensResolverId?: string;

  @ApiPropertyOptional()
  ensResolver?: EnsResolverDto;

  constructor(dns: DnsEntity) {
    super(dns);
    this.name = dns.name;
    this.chain = dns.chain;
    this.node = dns.node;
    this.cid = dns.cid;
    this.contentType = dns.contentType;
    this.tokenId = dns.tokenId;
    this.setupTxHash = dns.setupTxHash;
    this.logoUrl = dns.logoUrl;
    this.hasSite = dns.hasSite;
    this.main = dns.main;
    this.urls = dns.urls?.map((url) => url.toDto());
    this.expiresAt = dns.expiresAt;
    this.ensResolverId = dns.ensResolverId;
    this.ensResolver = dns.ensResolver?.toDto();

    if (dns.address) {
      this.address = dns.address;
      this.scannerUrl = `https://${
        dns.chain === ChainEnum.ETH ? "etherscan.io" : "polygonscan.com"
      }/address/${dns.address}`;
    }
  }
}
