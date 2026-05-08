import { Repository } from "typeorm";

import { CustomRepository } from "../../../db/typeorm-ex.decorator";
import { CidProcessingEntity } from "./cid-processing.entity";

@CustomRepository(CidProcessingEntity)
export class CidProcessingRepository extends Repository<CidProcessingEntity> {}
