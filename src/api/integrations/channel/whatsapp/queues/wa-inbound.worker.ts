import { WAMonitoringService } from '@api/services/monitor.service';
import { BullMQConfig, configService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { getBullMQConnection } from '@queues/bullmq-connection';
import { withInstanceLock } from '@queues/instance-lock';
import { fromJobSafe } from '@queues/job-serializer';
import { Job, Worker } from 'bullmq';

import { WA_INBOUND_QUEUE_NAME, WaInboundJobData } from './wa-inbound.queue';

const logger = new Logger('WaInboundWorker');

export function startWaInboundWorker(waMonitor: WAMonitoringService): Worker<WaInboundJobData> {
  const { CONCURRENCY } = configService.get<BullMQConfig>('BULLMQ').QUEUES.WA_INBOUND;

  const worker = new Worker<WaInboundJobData>(
    WA_INBOUND_QUEUE_NAME,
    async (job: Job<WaInboundJobData>) => {
      const { type, instanceName, settings } = job.data;
      const payload = fromJobSafe(job.data.payload);

      const instance = waMonitor.waInstances[instanceName];
      if (!instance) {
        logger.warn(`wa-inbound job for unknown/removed instance ${instanceName}, dropping`);
        return;
      }

      await withInstanceLock(instance.baileysCache, 'wa-inbound-lock', instanceName, () =>
        instance.processInboundEvent(type, payload, settings),
      );
    },
    { connection: getBullMQConnection(), concurrency: CONCURRENCY },
  );

  worker.on('failed', (job, err) =>
    logger.error(
      `wa-inbound job ${job?.id} (${job?.data?.type}, instance=${job?.data?.instanceName}) failed: ${err.message}`,
    ),
  );

  return worker;
}
