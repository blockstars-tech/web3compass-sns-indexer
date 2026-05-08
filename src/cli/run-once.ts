/**
 * Boot the Nest application context, run a single SNS job once, then exit.
 *
 *   yarn cli:once register
 *   yarn cli:once reconcile
 *   yarn cli:once record-changes
 *
 * Use this for the "controlled smoke run before enabling cron" workflow.
 *
 * Backfill is intentionally not in this list — it's a long-running
 * cron job (`sns-backfill.job`) gated by `SNS_BACKFILL_ENABLED`, not a
 * one-shot. Set the gate to `true` and the cron tick will drive it.
 */
import 'reflect-metadata';

import { type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { AppModule } from '../app.module';
import { SnsReconcileJob } from '../modules/sns/jobs/sns-reconcile.job';
import { SnsRecordChangesJob } from '../modules/sns/jobs/sns-record-changes.job';
import { SnsRegisterJob } from '../modules/sns/jobs/sns-register.job';

// Kebab-case CLI argument; matches the user-facing job name.
/* eslint-disable @typescript-eslint/naming-convention, quote-props */
const TARGETS = {
  register: SnsRegisterJob,
  reconcile: SnsReconcileJob,
  'record-changes': SnsRecordChangesJob,
} as const;
/* eslint-enable @typescript-eslint/naming-convention, quote-props */

type TargetName = keyof typeof TARGETS;

function isTarget(value: string): value is TargetName {
  return value in TARGETS;
}

async function run(): Promise<void> {
  const arg = process.argv[2];

  if (!arg || !isTarget(arg)) {
    // eslint-disable-next-line no-console
    console.error(
      'Usage: yarn cli:once <register|reconcile|record-changes>\n' +
        `Got: ${arg ?? '<none>'}`,
    );
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1);
  }

  const app: INestApplicationContext =
    await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const logger = app.get(Logger);
  logger.log(`cli:once ${arg} — starting`, 'RunOnce');

  const job = app.get(TARGETS[arg]);

  try {
    await job.handle();
    logger.log(`cli:once ${arg} — completed`, 'RunOnce');
  } finally {
    await app.close();
  }
}

run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('cli:once failed', error);
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(1);
});
