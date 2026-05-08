/**
 * Bootstrap as an application context (worker mode) — no HTTP server.
 * All work runs from cron jobs registered in SnsModule.
 */
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { ApiConfigService } from './modules/shared/services/api-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  const logger = app.get(Logger);
  const config = app.get(ApiConfigService);

  logger.log(
    'web3compass-sns-indexer started (application context, no HTTP)',
    'Bootstrap',
  );

  // Make the operating mode obvious. The cron decorators are always
  // registered; whether they actually do work each tick is gated by
  // ENABLE_SNS_CRONS (master switch) plus per-job gates. Without this
  // log a fresh `yarn dev` looks healthy but is silently idle.
  if (config.cronsEnabled) {
    const backfillStatus = config.backfillEnabled
      ? 'ON (every 2m)'
      : 'OFF (set SNS_BACKFILL_ENABLED=true to enable)';

    logger.log(
      `Cron jobs ENABLED — register (1m), record-changes (1m), reconcile (30s), backfill ${backfillStatus}`,
      'Bootstrap',
    );
  } else {
    logger.warn(
      'Cron jobs DISABLED (ENABLE_SNS_CRONS=false). Crons tick on schedule but each is a no-op. Set ENABLE_SNS_CRONS=true in .env to enable, or use `yarn cli:once <register|reconcile|record-changes>` for one-off runs.',
      'Bootstrap',
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`Received ${signal}, shutting down gracefully`, 'Bootstrap');
    await app.close();
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Bootstrap failed', error);
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(1);
});
