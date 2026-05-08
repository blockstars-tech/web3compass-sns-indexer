import { type DynamicModule, type Provider, type Type } from "@nestjs/common";
import { getDataSourceToken } from "@nestjs/typeorm";
import type { DataSource } from "typeorm";

import { TYPEORM_EX_CUSTOM_REPOSITORY } from "./typeorm-ex.decorator";

export class TypeOrmExModule {
  public static forCustomRepository<T extends Type<unknown>>(
    repositories: T[],
  ): DynamicModule {
    const providers: Provider[] = [];

    for (const repository of repositories) {
      const entity = Reflect.getMetadata(
        TYPEORM_EX_CUSTOM_REPOSITORY,
        repository,
      ) as Type<unknown>;

      if (!entity) {
        continue;
      }

      providers.push({
        inject: [getDataSourceToken()],
        provide: repository,
        useFactory: (dataSource: DataSource): InstanceType<T> => {
          const baseRepository = dataSource.getRepository<unknown>(entity);

          return new repository(
            baseRepository.target,
            baseRepository.manager,
            baseRepository.queryRunner,
          ) as InstanceType<T>;
        },
      });
    }

    return {
      exports: providers,
      module: TypeOrmExModule,
      providers,
    };
  }
}
