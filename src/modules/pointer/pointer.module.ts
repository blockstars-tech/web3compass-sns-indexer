import { Module } from "@nestjs/common";

import { TypeOrmExModule } from "../../db/typeorm-ex.module";
import { ContentPointerRepository } from "./content-pointer.repository";
import { ContentPointerService } from "./content-pointer.service";

/**
 * Listener-side pointer module: writes only. The full pipeline (resolvers,
 * scheduler, ingester) lives in the scrap-api repo. Will become a shared
 * package later.
 */
@Module({
  imports: [TypeOrmExModule.forCustomRepository([ContentPointerRepository])],
  providers: [ContentPointerService],
  exports: [ContentPointerService],
})
export class PointerModule {}
