import { Repository } from 'typeorm';

import { CustomRepository } from '../../db/typeorm-ex.decorator';
import { ContentPointerEntity } from './content-pointer.entity';

@CustomRepository(ContentPointerEntity)
export class ContentPointerRepository extends Repository<ContentPointerEntity> {}
