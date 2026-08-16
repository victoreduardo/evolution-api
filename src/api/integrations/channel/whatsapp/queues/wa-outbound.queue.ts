import { ChatwootMessage } from '@api/integrations/chatbot/chatwoot/services/chatwoot.service';
import { BullMQConfig, configService } from '@config/env.config';
import { getBullMQConnection, isBullMQEnabled } from '@queues/bullmq-connection';
import { toJobSafe } from '@queues/job-serializer';
import { Queue } from 'bullmq';

export const WA_OUTBOUND_QUEUE_NAME = 'wa-outbound';

export type WaOutboundJobData = {
  instanceName: string;
  number: string;
  message: unknown; // buffer-safe, run through toJobSafe()
  options?: unknown; // buffer-safe
  isIntegration: boolean;
  // set when this send originates from a Chatwoot agent reply, so the worker can link the
  // Chatwoot message record to the real WhatsApp message once it's actually sent.
  chatwootLinkContext?: ChatwootMessage;
};

let queue: Queue<WaOutboundJobData> | null = null;

export { isBullMQEnabled as isWaOutboundQueueAvailable };

function getQueue(): Queue<WaOutboundJobData> {
  if (queue) return queue;

  const { ATTEMPTS } = configService.get<BullMQConfig>('BULLMQ').QUEUES.WA_OUTBOUND;

  queue = new Queue<WaOutboundJobData>(WA_OUTBOUND_QUEUE_NAME, {
    connection: getBullMQConnection(),
    defaultJobOptions: {
      attempts: ATTEMPTS,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: { age: 3600, count: 2000 },
      removeOnFail: { age: 86400 },
    },
  });

  return queue;
}

export async function enqueueWaOutbound(data: WaOutboundJobData): Promise<{ jobId: string }> {
  const job = await getQueue().add('send', {
    ...data,
    message: toJobSafe(data.message),
    options: toJobSafe(data.options),
  });
  return { jobId: job.id as string };
}
