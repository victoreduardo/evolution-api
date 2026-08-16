import { BullMQConfig, CacheConf, configService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import IORedis from 'ioredis';

const logger = new Logger('BullMQConnection');

let connection: IORedis | null = null;

export function isBullMQEnabled(): boolean {
  return configService.get<BullMQConfig>('BULLMQ').ENABLED && configService.get<CacheConf>('CACHE').REDIS.ENABLED;
}

export function getBullMQConnection(): IORedis {
  if (connection) return connection;

  const { URI } = configService.get<CacheConf>('CACHE').REDIS;

  // maxRetriesPerRequest must be null: required by BullMQ for its blocking commands.
  connection = new IORedis(URI, { maxRetriesPerRequest: null });

  connection.on('error', (err) => logger.error(`BullMQ redis connection error: ${err.message}`));
  connection.on('ready', () => logger.verbose('BullMQ redis connection ready'));

  return connection;
}
