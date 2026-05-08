/**
 * Pino logger options. Vendored shape from
 * `web3compassapi/src/config/logger.ts` so both services produce the
 * same on-disk log format and rotation pattern — `logs/app-*.log`,
 * 100MB or 1d rotation, gzipped, ECS-formatted.
 *
 * Modes:
 *   LOG_LEVEL=debug  → pino-pretty stream to stdout (no file). For
 *                      local development.
 *   LOG_LEVEL=info   → ECS-formatted JSON to logs/app-YYYY-MM-DD-N.log,
 *   (or anything       rotated daily and at 100MB. For staging / prod.
 *    other than
 *    debug)
 *
 * The `dotenv/config` import at the top is intentional — this file is
 * imported from `app.module.ts` before NestJS reads env, and the
 * `process.env.LOG_LEVEL` switch needs to fire at module evaluation
 * time, not after NestJS' `ConfigModule.forRoot()` runs.
 */
import 'dotenv/config';

import { ecsFormat } from '@elastic/ecs-pino-format';
import type { Params } from 'nestjs-pino';
import path from 'path';
import { createStream } from 'rotating-file-stream';

const pad = (num: number): string => (num > 9 ? '' : '0') + num.toString();

const generator = (time: Date | number | null, index?: number): string => {
  if (!time) {
    return path.join(__dirname, '..', '..', 'logs', 'app.log');
  }

  const now = time instanceof Date ? time : new Date(time);
  const year = now.getFullYear().toString();
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());

  return path.join(
    __dirname,
    '..',
    '..',
    'logs',
    `app-${year}-${month}-${day}-${index ?? 1}.log`,
  );
};

export const loggerOptions: Params = {
  pinoHttp: {
    level: process.env.LOG_LEVEL || 'info',
    ...(process.env.LOG_LEVEL === 'debug'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, singleLine: true },
          },
        }
      : {
          ...ecsFormat({ apmIntegration: false }),
          stream: createStream(generator, {
            size: '100M',
            interval: '1d',
            compress: 'gzip',
            immutable: true,
          }),
        }),
  },
};
