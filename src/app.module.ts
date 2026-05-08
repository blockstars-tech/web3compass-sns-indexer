import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';

import { loggerOptions } from './config/logger';
import { ApiConfigService } from './modules/shared/services/api-config.service';
import { SharedModule } from './modules/shared/shared.module';
import { SnsModule } from './modules/sns/sns.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    // File-rotated ECS logs at LOG_LEVEL=info; pino-pretty stdout at
    // LOG_LEVEL=debug. See src/config/logger.ts.
    LoggerModule.forRoot(loggerOptions),

    TypeOrmModule.forRootAsync({
      imports: [SharedModule],
      inject: [ApiConfigService],
      useFactory: (cfg: ApiConfigService) => cfg.typeOrmConfig,
    }),

    ScheduleModule.forRoot(),

    SharedModule,
    SnsModule,
  ],
})
export class AppModule {}
