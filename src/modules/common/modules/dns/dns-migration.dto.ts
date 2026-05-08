import { ApiProperty } from "@nestjs/swagger";

import type { ChainEnum } from "../../../../constants/chain.enum";
import type { DnsMigrationEntity } from "../../../dns/dns-migration.entity";
import { AbstractDto } from "../../dtoes/abstract.dto";

export class DnsMigrationDto extends AbstractDto {
  @ApiProperty()
  lastMigratedBlockNumber: number;

  @ApiProperty()
  isMigrated: boolean;

  @ApiProperty()
  chain: ChainEnum;

  constructor(dnsMigration: DnsMigrationEntity) {
    super(dnsMigration);

    this.lastMigratedBlockNumber = dnsMigration.lastMigratedBlockNumber;
    this.isMigrated = dnsMigration.isMigrated;
    this.chain = dnsMigration.chain;
  }
}
