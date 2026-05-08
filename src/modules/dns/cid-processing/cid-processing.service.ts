/* eslint-disable unicorn/no-null -- TypeORM-idiomatic clear sentinel for nullable columns */
import { Inject, Injectable } from "@nestjs/common";
import { InjectPinoLogger, type PinoLogger } from "nestjs-pino";
import { DataSource, type EntityManager } from "typeorm";

import { DnsEntity } from "../dns.entity";
import { CidProcessingEntity } from "./cid-processing.entity";
import { CidProcessingRepository } from "./cid-processing.repository";

/**
 * Mirrors the upstream EVM `handleCidChange` flow: when a domain's CID
 * changes, look up the old CID's processing-group row, remove this domain
 * from it (and tear the group down if this row was the primary), then
 * clear `cidProcessingId` + `isPrimary` on the dns row.
 *
 * Group *creation* is intentionally not implemented — neither is it
 * implemented for EVM today. The downstream content-indexer service
 * activates that flow when it's ready. We only need the cleanup half so
 * stale group memberships don't pile up.
 */
@Injectable()
export class CidProcessingService {
  constructor(
    @InjectPinoLogger(CidProcessingService.name)
    private readonly logger: PinoLogger,
    @Inject(CidProcessingRepository)
    private readonly repo: CidProcessingRepository,
    @Inject(DataSource)
    private readonly ds: DataSource,
  ) {}

  /**
   * Detach a dns row from its old CID's processing group. Mutates the row
   * in-place (`cidProcessingId = null`, `isPrimary = false`); caller is
   * responsible for the subsequent `save`.
   */
  async handleCidChange(dns: DnsEntity, oldCid: string | null): Promise<void> {
    if (oldCid) {
      try {
        await this.ds.transaction(async (manager) => {
          const cidProcessing = await manager.findOne(CidProcessingEntity, {
            where: { cid: oldCid },
          });

          if (cidProcessing) {
            await this.handleRemovalFromOldCid(manager, dns, cidProcessing);
          }
        });
      } catch (error) {
        this.logger.error(
          `Failed to handle CID change for dns ${dns.id}: ${(error as Error).message}`,
        );
        throw error;
      }
    }

    dns.cidProcessingId = null;
    dns.isPrimary = false;
  }

  private async handleRemovalFromOldCid(
    manager: EntityManager,
    dns: DnsEntity,
    cidProcessing: CidProcessingEntity,
  ): Promise<void> {
    cidProcessing.associatedDomains = (
      cidProcessing.associatedDomains ?? []
    ).filter((domain) => domain !== dns.name);

    if (cidProcessing.primaryDnsId === dns.id) {
      // Primary leaving — either elect a new primary from the survivors
      // (we leave that to the content-indexer when it owns the group), or
      // tear the row down if the group is now empty.
      if (cidProcessing.associatedDomains.length > 0) {
        const survivors = await manager
          .createQueryBuilder(DnsEntity, "dns")
          .where("dns.name IN (:...domains)", {
            domains: cidProcessing.associatedDomains,
          })
          .getMany();

        for (const survivor of survivors) {
          survivor.cidProcessingId = null;
          survivor.isPrimary = false;
          survivor.ipfsProcessed = false;
          await manager.save(survivor);
        }
      }

      await manager.remove(cidProcessing);

      return;
    }

    await manager.save(cidProcessing);
  }
}
