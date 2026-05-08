import { SetMetadata, type Type } from "@nestjs/common";

export const TYPEORM_EX_CUSTOM_REPOSITORY = "TYPEORM_EX_CUSTOM_REPOSITORY";

export function CustomRepository(entity: Type): ClassDecorator {
  return SetMetadata(TYPEORM_EX_CUSTOM_REPOSITORY, entity);
}
