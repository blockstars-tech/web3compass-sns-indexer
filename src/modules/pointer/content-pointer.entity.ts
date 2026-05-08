import { Column, Entity, Index, JoinColumn, OneToOne } from "typeorm";

import { AbstractDto } from "../common/dtoes/abstract.dto";
import { AbstractEntity } from "../common/entities/abstract.entity";
import { DnsEntity } from "../dns/dns.entity";

export enum PointerKind {
  IPNS = "ipns",
  SWARM_FEED = "swarm_feed",
  DNSLINK = "dnslink",
  TON_DNS_HTTP = "ton_dns_http",
}

export enum AnchorKind {
  IPFS_CID = "ipfs_cid",
  SWARM_BZZ = "swarm_bzz",
  HTTP_URL = "http_url",
}

export enum PointerState {
  COLD = "cold",
  HEALTHY = "healthy",
  SLOW = "slow",
  FAILING = "failing",
}

/**
 * Mutable-pointer state. One row per dns row whose contentType is a
 * mutable kind (ipns-ns, swarm-ns, dnslink, ...). Immutable ipfs-ns rows
 * do not get a pointer row; their dns.cid is already the anchor.
 *
 * Listener-side copy. Resolution + ingestion live in the downstream
 * content-indexer; this module only handles writes (insert/update/delete)
 * on ContenthashChanged events. Will become a shared package later.
 */
@Entity({ name: "content_pointer" })
export class ContentPointerEntity extends AbstractEntity<AbstractDto> {
  @Column("uuid")
  @Index({ unique: true })
  dnsId: string;

  @OneToOne(() => DnsEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "dns_id" })
  dns?: DnsEntity;

  @Column({ type: "text" })
  @Index()
  kind: PointerKind;

  /** k51..., bzz feed (owner:topic), DNSLink domain, or TON domain. */
  @Column({ type: "text" })
  pointerValue: string;

  /** Latest resolved anchor: IPFS CID, Swarm bzz hex, or HTTP URL hash. */
  @Column({ type: "text", nullable: true })
  currentAnchor?: string;

  @Column({ type: "text", nullable: true })
  currentAnchorKind?: AnchorKind;

  @Column({ type: "timestamptz", nullable: true })
  currentAnchorFirstSeen?: Date;

  @Column({ type: "timestamptz", nullable: true })
  lastChangedAt?: Date;

  /** Set when current_anchor changes; cleared by indexing orchestrator. */
  @Column({ default: false })
  @Index()
  anchorDirty: boolean;

  @Column({ type: "timestamptz" })
  @Index()
  nextResolveAt: Date;

  @Column({ type: "timestamptz", nullable: true })
  lastResolvedAt?: Date;

  /** Clamped [TTL_MIN, TTL_MAX]. */
  @Column({ type: "int", nullable: true })
  ttlObservedSeconds?: number;

  /** Rolling window, max 10 entries, used by EWMA scheduler. */
  @Column("int", { array: true, default: () => "ARRAY[]::int[]" })
  observedIntervalsSec: number[];

  @Column({ default: 0 })
  resolveFailStreak: number;

  @Column({ type: "text", nullable: true })
  lastResolveError?: string;

  @Column({ type: "text", default: PointerState.COLD })
  @Index()
  state: PointerState;

  // AbstractEntity requires this; pointer rows are not externally serialized.
  dtoClass = AbstractDto;
}
