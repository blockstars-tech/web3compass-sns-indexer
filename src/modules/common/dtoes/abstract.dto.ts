import type { AbstractEntity } from '../entities/abstract.entity';

export class AbstractDto {
  id: string;

  createdAt: Date;

  updatedAt: Date;

  constructor(entity: AbstractEntity<AbstractDto>) {
    this.id = entity.id;
    this.createdAt = entity.createdAt;
    this.updatedAt = entity.updatedAt;
  }
}
