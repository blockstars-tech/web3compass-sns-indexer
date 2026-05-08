import { Repository } from 'typeorm';

import { CustomRepository } from '../../db/typeorm-ex.decorator';
import { DnsEntity } from './dns.entity';

@CustomRepository(DnsEntity)
export class DnsRepository extends Repository<DnsEntity> {
  async findByNode(node: string) {
    return this.createQueryBuilder('dns')
      .where('dns.node = :node', { node })
      .getOne();
  }

  async findByName(name: string) {
    return this.createQueryBuilder('dns')
      .where('dns.name = :name', { name })
      .getOne();
  }

  /**
   * Drains rows that still need first-time content resolution. Used by
   * the SNS reconcile job.
   *
   * Filter intent:
   *  - `chain` scopes the drain (don't pick up EVM rows).
   *  - `cid IS NULL` selects rows that haven't been resolved yet — newly
   *    registered domains, or backfill skeletons. Once a CID is set, the
   *    row leaves this queue; future content changes are picked up
   *    inline by `SnsRecordChangesJob`, mirroring the EVM
   *    `updateEnsContent` flow.
   *  - `is_fetch_failed` excludes rows the resolver has already given up
   *    on after `MAX_IPFS_FETCH_RETRY_ATTEMPTS` empty resolves. Those can
   *    only re-enter the queue via a record-change event (which clears
   *    `is_fetch_failed` on a hit) or admin intervention.
   *
   * `needs_reindex` is **not** in this query — that flag is reserved for
   * the admin "manual re-trigger" path used by the downstream
   * content-indexer's `prepareIndexedRecordsForReindexing`, not the SNS
   * workflow.
   */
  async findUnresolved(chain: string, limit = 100): Promise<DnsEntity[]> {
    return this.createQueryBuilder('dns')
      .where('dns.chain = :chain', { chain })
      .andWhere('dns.cid IS NULL')
      .andWhere(
        '(dns.is_fetch_failed IS NULL OR dns.is_fetch_failed = :failed)',
        { failed: false },
      )
      .orderBy('dns.created_at', 'ASC')
      .limit(limit)
      .getMany();
  }
}
