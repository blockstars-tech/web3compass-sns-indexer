import { Repository } from "typeorm";

import { CustomRepository } from "../../db/typeorm-ex.decorator";
import { DnsSettingsEntity } from "./dns-settings.entity";

@CustomRepository(DnsSettingsEntity)
export class DnsSettingsRepository extends Repository<DnsSettingsEntity> {}
