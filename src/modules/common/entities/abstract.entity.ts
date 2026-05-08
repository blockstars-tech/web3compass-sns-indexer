import {
  CreateDateColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { UtilsProvider } from '../../../providers/utils.provider';
import type { AbstractDto } from '../dtoes/abstract.dto';

export abstract class AbstractEntity<DTO extends AbstractDto> {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({
    type: 'timestamp without time zone',
    name: 'created_at',
  })
  createdAt: Date;

  @UpdateDateColumn({
    type: 'timestamp without time zone',
    name: 'updated_at',
  })
  updatedAt: Date;

  abstract dtoClass: new (
    entity: AbstractEntity<DTO>,
    options?: Record<string, unknown>,
  ) => DTO;

  toDto(options?: Record<string, unknown>): DTO {
    return UtilsProvider.toDto(this.dtoClass, this, options);
  }
}
