import { BullMQConfig, configService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { getBullMQConnection } from '@queues/bullmq-connection';
import { fromJobSafe } from '@queues/job-serializer';
import { Job, Worker } from 'bullmq';

import { PrismaRepository } from '@api/repository/repository.service';

import { ChatwootService } from '../services/chatwoot.service';
import { CHATWOOT_FORWARD_QUEUE_NAME, ChatwootForwardJobData } from './chatwoot-forward.queue';

const logger = new Logger('ChatwootForwardWorker');

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Chatwoot forward timed out after ${ms}ms`)), ms)),
  ]);
}

export function startChatwootForwardWorker(
  chatwootService: ChatwootService,
  prismaRepository: PrismaRepository,
): Worker<ChatwootForwardJobData> {
  const { CONCURRENCY, TIMEOUT_MS } = configService.get<BullMQConfig>('BULLMQ').QUEUES.CHATWOOT_FORWARD;

  const worker = new Worker<ChatwootForwardJobData>(
    CHATWOOT_FORWARD_QUEUE_NAME,
    async (job: Job<ChatwootForwardJobData>) => {
      const { event, instanceName, instanceId, body, messageDbId, chatwootLinkContext } = job.data;

      const sent = await withTimeout(
        chatwootService.eventWhatsapp(event, { instanceName, instanceId }, fromJobSafe(body)),
        TIMEOUT_MS,
      );

      if (sent?.id && messageDbId) {
        await prismaRepository.message.update({
          where: { id: messageDbId },
          data: {
            chatwootMessageId: sent.id,
            chatwootInboxId: sent.inbox_id,
            chatwootConversationId: sent.conversation_id,
          },
        });
      }

      if (sent?.id && chatwootLinkContext) {
        await chatwootService.updateChatwootMessageId(fromJobSafe(body), chatwootLinkContext, {
          instanceName,
          instanceId,
        });
      }
    },
    { connection: getBullMQConnection(), concurrency: CONCURRENCY },
  );

  worker.on('failed', (job, err) =>
    logger.error(
      `Chatwoot forward job ${job?.id} (event=${job?.data?.event}) failed (attempt ${job?.attemptsMade}): ${err.message}`,
    ),
  );

  return worker;
}
