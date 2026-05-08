import { Inject, Injectable } from "@nestjs/common";
import { InjectPinoLogger, type PinoLogger } from "nestjs-pino";

import { ApiConfigService } from "../shared/services/api-config.service";
import { DnsEntity } from "./dns.entity";
import { DnsSettingsEntity } from "./dns-settings.entity";
import { DnsSettingsRepository } from "./dns-settings.repository";

/**
 * Audit-row writer for content changes. EVM jobs in `web3compassapi` create
 * a `dns_settings` row on every save that touches `cid` or `setupTxHash`;
 * the SNS reconcile job mirrors that contract so downstream consumers see
 * a uniform shape regardless of chain.
 *
 * One row captures: the txHash that triggered the change, the resulting
 * cid, the gateway URL we believed served it, and a back-reference to the
 * dns row.
 */
@Injectable()
export class DnsSettingsService {
  constructor(
    @InjectPinoLogger(DnsSettingsService.name)
    private readonly logger: PinoLogger,
    @Inject(DnsSettingsRepository)
    private readonly repo: DnsSettingsRepository,
    @Inject(ApiConfigService)
    private readonly configService: ApiConfigService,
  ) {}

  async createDnsSettings(dns: DnsEntity): Promise<DnsSettingsEntity> {
    const ipfsUrl = dns.cid
      ? `${this.configService.ipfsGatewayUrl}${dns.cid}`
      : undefined;

    const row = this.repo.create({
      txHash: dns.setupTxHash ?? "",
      cid: dns.cid,
      logoUrl: dns.logoUrl,
      ipfsUrl,
      dnsId: dns.id,
    });

    const saved = await this.repo.save(row);
    this.logger.debug(
      `dns_settings written for ${dns.name} (cid=${dns.cid ?? "null"})`,
    );

    return saved;
  }
}
