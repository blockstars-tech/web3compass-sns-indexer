import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";

import { AbstractEntity } from "../common/entities/abstract.entity";
import { UrlDto } from "../common/modules/dns/url.dto";
import { DnsEntity } from "./dns.entity";

@Entity({ name: "urls" })
export class UrlEntity extends AbstractEntity<UrlDto> {
  @Column()
  url: string;

  @Column()
  cid: string;

  @Column()
  dnsId: string;

  @ManyToOne(() => DnsEntity, (dnsEntity) => dnsEntity.urls, {
    onDelete: "CASCADE",
    onUpdate: "CASCADE",
  })
  @JoinColumn({ name: "dns_id" })
  dns: DnsEntity;

  @Column({ default: 0, comment: "To track the version of the urls" })
  @Index()
  version: number;

  dtoClass = UrlDto;
}
