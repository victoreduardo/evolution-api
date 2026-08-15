import { WAMonitoringService } from '@api/services/monitor.service';
import { BullMQConfig, configService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { getBullMQConnection } from '@queues/bullmq-connection';
import { withInstanceLock } from '@queues/instance-lock';
import { fromJobSafe } from '@queues/job-serializer';
import { Job, Worker } from 'bullmq';

import { WA_OUTBOUND_QUEUE_NAME, WaOutboundJobData } from './wa-outbound.queue';

const logger = new Logger('WaOutboundWorker');

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Send timed out after ${ms}ms`)), ms)),
  ]);
}

export function startWaOutboundWorker(waMonitor: WAMonitoringService): Worker<WaOutboundJobData> {
  const { CONCURRENCY, TIMEOUT_MS } = configService.get<BullMQConfig>('BULLMQ').QUEUES.WA_OUTBOUND;

  const worker = new Worker<WaOutboundJobData>(
    WA_OUTBOUND_QUEUE_NAME,
    async (job: Job<WaOutboundJobData>) => {
      const { instanceName, number, isIntegration, chatwootLinkContext } = job.data;
      const message = fromJobSafe(job.data.message);
      const options = fromJobSafe(job.data.options ?? {});

      const instance = waMonitor.waInstances[instanceName];
      if (!instance) {
        // instance may reconnect before retries are exhausted - let BullMQ retry
        throw new Error(`Instance ${instanceName} not found`);
      }

      await withInstanceLock(getBullMQConnection(), 'wa-outbound-lock', instanceName, () =>
        withTimeout(
          instance.executeSendMessage(number, message, options, isIntegration, chatwootLinkContext, true),
          TIMEOUT_MS,
        ),
      );
    },
    { connection: getBullMQConnection(), concurrency: CONCURRENCY },
  );

  worker.on('failed', (job, err) =>
    logger.error(
      `wa-outbound job ${job?.id} (instance=${job?.data?.instanceName}) failed (attempt ${job?.attemptsMade}): ${err.message}`,
    ),
  );

  return worker;
}
