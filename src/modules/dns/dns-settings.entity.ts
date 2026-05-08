import { Column, Entity, JoinColumn, ManyToOne } from "typeorm";

import { AbstractEntity } from "../common/entities/abstract.entity";
import { DnsSettingsDto } from "../common/modules/dns/dns-settings.dto";
import { DnsEntity } from "./dns.entity";

@Entity("dns_settings")
export class DnsSettingsEntity extends AbstractEntity<DnsSettingsDto> {
  @Column({ nullable: false })
  txHash: string;

  @Column({ nullable: true })
  dnsId: string;

  @Column({ nullable: true })
  cid?: string;

  @Column({ nullable: true })
  logoUrl?: string;

  @Column({ nullable: true })
  ipfsUrl?: string;

  @ManyToOne(() => DnsEntity, (dnsEntity) => dnsEntity.settings, {
    onDelete: "CASCADE",
    onUpdate: "CASCADE",
  })
  @JoinColumn({ name: "dns_id" })
  dns: DnsEntity;

  dtoClass = DnsSettingsDto;
}
