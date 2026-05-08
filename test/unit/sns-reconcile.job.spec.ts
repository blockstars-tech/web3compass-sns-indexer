import { describe, expect, it, vi } from 'vitest';

import {
  MAX_IPFS_FETCH_RETRY_ATTEMPTS,
  StatusCodes,
} from '../../src/constants/dns.constants';
import {
  applyResolution,
  type IReconcilableDnsRow,
  type IReconcileSideEffects,
} from '../../src/modules/sns/jobs/sns-reconcile.state';

function makeRow(
  overrides: Partial<IReconcilableDnsRow> = {},
): IReconcilableDnsRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'bonfida.sol',
    ipfsFetchAttempt: 0,
    attempt: 0,
    ...overrides,
  };
}

function makeEffects(): IReconcileSideEffects & {
  handleCidChange: ReturnType<typeof vi.fn>;
  saveRow: ReturnType<typeof vi.fn>;
  createDnsSettings: ReturnType<typeof vi.fn>;
  syncFromDns: ReturnType<typeof vi.fn>;
} {
  return {
    handleCidChange: vi.fn(async (row: IReconcilableDnsRow) => {
      row.cidProcessingId = null;
      row.isPrimary = false;
    }),
    saveRow: vi.fn(async (row: IReconcilableDnsRow) => row),
    createDnsSettings: vi.fn(async () => undefined),
    syncFromDns: vi.fn(async () => undefined),
  };
}

describe('applyResolution', () => {
  it('first hit (no previous CID): writes cid, ipfsProcessed=false (queues for scrap-api), audit + sync fire', async () => {
    const effects = makeEffects();
    const row = makeRow();

    await applyResolution(
      row,
      {
        cid: 'QmNew',
        contentType: 'ipfs-ns',
        source: 'v2-ipfs',
        roaVerified: true,
      },
      effects,
    );

    expect(row.cid).toBe('QmNew');
    expect(row.contentType).toBe('ipfs-ns');
    expect(row.ipfsFetchStatus).toBe(StatusCodes.SUCCESS);
    // ipfsProcessed=false hands off to scrap-api (it filters
    // ipfs_processed=false to find work).
    expect(row.ipfsProcessed).toBe(false);
    expect(row.isFetchFailed).toBe(false);
    expect(effects.handleCidChange).not.toHaveBeenCalled();
    expect(effects.createDnsSettings).toHaveBeenCalledOnce();
    expect(effects.syncFromDns).toHaveBeenCalledWith({
      dnsId: row.id,
      contentType: 'ipfs-ns',
      cid: 'QmNew',
    });
  });

  it('hit with same CID: no audit, no sync, miss-counter resets, ipfsProcessed untouched', async () => {
    const effects = makeEffects();
    const row = makeRow({
      cid: 'QmSame',
      contentType: 'ipfs-ns',
      attempt: 5,
      ipfsFetchAttempt: 2,
      ipfsProcessed: true,
    });

    await applyResolution(
      row,
      { cid: 'QmSame', contentType: 'ipfs-ns', source: 'v1-ipfs' },
      effects,
    );

    expect(row.cid).toBe('QmSame');
    // `attempt` is the scrap-api retry counter — reconcile never resets it
    // on the same-cid path; only scrap-api does on a successful scrape.
    expect(row.attempt).toBe(5);
    // Resolution succeeded, so the consecutive-miss counter resets.
    expect(row.ipfsFetchAttempt).toBe(0);
    expect(row.isFetchFailed).toBe(false);
    expect(row.ipfsFetchStatus).toBe(StatusCodes.SUCCESS);
    // ipfsProcessed must NOT change on same-cid — scrap-api owns it on
    // this path.
    expect(row.ipfsProcessed).toBe(true);
    expect(effects.handleCidChange).not.toHaveBeenCalled();
    expect(effects.createDnsSettings).not.toHaveBeenCalled();
    expect(effects.syncFromDns).not.toHaveBeenCalled();
  });

  it('hit with new CID (changed): handleCidChange runs, counters reset, ipfsProcessed=false re-queues for scrap-api', async () => {
    const effects = makeEffects();
    const row = makeRow({
      cid: 'QmOld',
      contentType: 'ipfs-ns',
      attempt: 3,
      ipfsFetchAttempt: 1,
      ipfsProcessed: true,
    });

    await applyResolution(
      row,
      {
        cid: 'QmNew',
        contentType: 'arweave-ns',
        source: 'v2-arwv',
        roaVerified: true,
      },
      effects,
    );

    expect(effects.handleCidChange).toHaveBeenCalledWith(row, 'QmOld');
    expect(row.cid).toBe('QmNew');
    expect(row.contentType).toBe('arweave-ns');
    expect(row.attempt).toBe(0);
    expect(row.ipfsFetchAttempt).toBe(0);
    expect(row.isFetchFailed).toBe(false);
    expect(row.ipfsProcessed).toBe(false);
    expect(effects.createDnsSettings).toHaveBeenCalledOnce();
    expect(effects.syncFromDns).toHaveBeenCalledWith({
      dnsId: row.id,
      contentType: 'arweave-ns',
      cid: 'QmNew',
    });
  });

  it('miss with no prior CID, first attempt: FAILED, ipfsFetchAttempt=1, isFetchFailed=false, no audit, no sync', async () => {
    const effects = makeEffects();
    const row = makeRow({ ipfsFetchAttempt: 0 });

    await applyResolution(row, {}, effects);

    expect(row.cid).toBeNull();
    expect(row.contentType).toBeNull();
    expect(row.ipfsFetchStatus).toBe(StatusCodes.FAILED);
    expect(row.ipfsFetchAttempt).toBe(1);
    expect(row.isFetchFailed).toBe(false);
    expect(row.ipfsProcessed).toBe(true);
    // No state to record — no prior cid means no pointer existed and no
    // audit row is meaningful.
    expect(effects.createDnsSettings).not.toHaveBeenCalled();
    expect(effects.syncFromDns).not.toHaveBeenCalled();
  });

  it('miss with no prior CID after MAX-1 attempts hits the cap and flips isFetchFailed=true', async () => {
    const effects = makeEffects();
    const row = makeRow({
      ipfsFetchAttempt: MAX_IPFS_FETCH_RETRY_ATTEMPTS - 1,
    });

    await applyResolution(row, {}, effects);

    expect(row.ipfsFetchAttempt).toBe(MAX_IPFS_FETCH_RETRY_ATTEMPTS);
    expect(row.isFetchFailed).toBe(true);
  });

  it('miss when row previously had a CID: handleCidChange runs, cid+contentType cleared, audit + sync fire to delete pointer', async () => {
    const effects = makeEffects();
    const row = makeRow({ cid: 'QmOld', contentType: 'ipfs-ns' });

    await applyResolution(row, {}, effects);

    expect(effects.handleCidChange).toHaveBeenCalledWith(row, 'QmOld');
    expect(row.cid).toBeNull();
    expect(row.contentType).toBeNull();
    expect(row.ipfsFetchStatus).toBe(StatusCodes.FAILED);
    expect(row.ipfsProcessed).toBe(true);
    expect(effects.createDnsSettings).toHaveBeenCalledOnce();
    expect(effects.syncFromDns).toHaveBeenCalledWith({
      dnsId: row.id,
      contentType: null,
      cid: null,
    });
  });
});
