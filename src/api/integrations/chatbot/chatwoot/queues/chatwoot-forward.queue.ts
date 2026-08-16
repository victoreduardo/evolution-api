import { BullMQConfig, configService } from '@config/env.config';
import { getBullMQConnection, isBullMQEnabled } from '@queues/bullmq-connection';
import { toJobSafe } from '@queues/job-serializer';
import { Queue } from 'bullmq';

import { ChatwootMessage } from '../services/chatwoot.service';

export const CHATWOOT_FORWARD_QUEUE_NAME = 'chatwoot-forward';

export type ChatwootForwardJobData = {
  event: string; // e.g. 'messages.upsert' | 'messages.read' | 'messages.delete' | 'messages.edit' | 'send.message'
  instanceName: string;
  instanceId: string;
  body: unknown; // buffer-safe, run through toJobSafe()
  // set when this event is a WhatsApp-received message that got persisted locally, so the
  // worker can patch chatwootMessageId/chatwootConversationId/chatwootInboxId onto that row
  // once Chatwoot confirms the forward.
  messageDbId?: string;
  // set when this forward originates from a wa-outbound send that needs the Chatwoot message
  // record (an agent reply) linked back to the real WhatsApp message afterwards.
  chatwootLinkContext?: ChatwootMessage;
};

let queue: Queue<ChatwootForwardJobData> | null = null;

export { isBullMQEnabled as isChatwootForwardQueueAvailable };

function getQueue(): Queue<ChatwootForwardJobData> {
  if (queue) return queue;

  const { ATTEMPTS } = configService.get<BullMQConfig>('BULLMQ').QUEUES.CHATWOOT_FORWARD;

  queue = new Queue<ChatwootForwardJobData>(CHATWOOT_FORWARD_QUEUE_NAME, {
    connection: getBullMQConnection(),
    defaultJobOptions: {
      attempts: ATTEMPTS,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400 },
    },
  });

  return queue;
}

export async function enqueueChatwootEvent(
  data: Omit<ChatwootForwardJobData, 'body'> & { body: unknown },
): Promise<void> {
  await getQueue().add('forward', { ...data, body: toJobSafe(data.body) });
}
