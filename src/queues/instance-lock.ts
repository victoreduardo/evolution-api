import { CacheService } from '@api/services/cache.service';

const LOCK_POLLING_DELAY_MS = 100;
const LOCK_MAX_WAIT_MS = 30000;
const LOCK_TTL_SECONDS = 30;

// Serializes work per WhatsApp instance across concurrent BullMQ workers, so events/sends for
// a given instance still process in the order they were enqueued (chat/unread-count state and
// message ordering assume this) while different instances still run in parallel.
export async function withInstanceLock<T>(
  cache: CacheService,
  lockKeyPrefix: string,
  instanceName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockKey = `${lockKeyPrefix}:${instanceName}`;
  const start = Date.now();

  while (await cache.has(lockKey)) {
    if (Date.now() - start > LOCK_MAX_WAIT_MS) break;
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLLING_DELAY_MS));
  }

  await cache.set(lockKey, true, LOCK_TTL_SECONDS);
  try {
    return await fn();
  } finally {
    await cache.delete(lockKey);
  }
}
