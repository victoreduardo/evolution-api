import { getBullMQConnection, isBullMQEnabled } from '@queues/bullmq-connection';
import { toJobSafe } from '@queues/job-serializer';
import { Queue } from 'bullmq';

export const WA_INBOUND_QUEUE_NAME = 'wa-inbound';

export type WaInboundJobData = {
  type: 'messages.upsert' | 'messages.update';
  instanceName: string;
  payload: unknown; // buffer-safe, run through toJobSafe()
  settings: unknown;
};

let queue: Queue<WaInboundJobData> | null = null;

export { isBullMQEnabled as isWaInboundQueueAvailable };

function getQueue(): Queue<WaInboundJobData> {
  if (queue) return queue;

  queue = new Queue<WaInboundJobData>(WA_INBOUND_QUEUE_NAME, {
    connection: getBullMQConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600, count: 2000 },
      removeOnFail: { age: 86400 },
    },
  });

  return queue;
}

export async function enqueueWaInbound(data: WaInboundJobData): Promise<void> {
  await getQueue().add(data.type, { ...data, payload: toJobSafe(data.payload) });
}
