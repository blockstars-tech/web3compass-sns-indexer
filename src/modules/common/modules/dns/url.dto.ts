import { ApiProperty } from "@nestjs/swagger";

import type { UrlEntity } from "../../../dns/url.entity";
import { AbstractDto } from "../../dtoes/abstract.dto";
import type { DnsDto } from "./dns.dto";

export class UrlDto extends AbstractDto {
  @ApiProperty()
  dns?: DnsDto;

  @ApiProperty()
  url: string;

  @ApiProperty()
  cid: string;

  @ApiProperty()
  dnsId: string;

  version: number;

  constructor(url: UrlEntity) {
    super(url);
    this.dns = url.dns?.toDto();
    this.dnsId = url.dnsId;
    this.url = url.url;
    this.cid = url.cid;
    this.version = url.version;
  }
}
