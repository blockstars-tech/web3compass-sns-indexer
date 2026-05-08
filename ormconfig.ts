/**
 * TypeORM CLI DataSource.
 *
 * NOTE: This repo does NOT run migrations. Schema is owned by
 * `web3compassapi`. The CLI commands (`typeorm migration:*`) are intentionally
 * not wired up; this file exists so editor tooling can resolve the data source
 * for type-checking and entity scanning during local development.
 *
 * If you find yourself wanting to add a migration here, STOP. Open the PR
 * against `web3compassapi` instead. See docs/adr/0002-no-migrations-in-this-repo.md.
 */
import { config } from 'dotenv';
import { DataSource } from 'typeorm';

import { SnakeNamingStrategy } from './src/strategies/snake-naming.strategy';

config({ path: '.env' });

export default new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  namingStrategy: new SnakeNamingStrategy(),
  entities: ['src/modules/**/*.entity{.ts,.js}'],
  migrations: [],
  migrationsRun: false,
  synchronize: false,
});
