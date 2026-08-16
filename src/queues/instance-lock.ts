import IORedis from 'ioredis';

const LOCK_POLLING_DELAY_MS = 100;
const LOCK_MAX_WAIT_MS = 30000;
const LOCK_TTL_MS = 30000;

// Serializes work per WhatsApp instance across concurrent BullMQ workers, so events/sends for
// a given instance still process in the order they were enqueued (chat/unread-count state and
// message ordering assume this) while different instances still run in parallel.
//
// Uses Redis SET...NX directly (atomic) rather than a has()-then-set() check, which races under
// real concurrency: two workers can both see "no lock" before either writes one.
export async function withInstanceLock<T>(
  redis: IORedis,
  lockKeyPrefix: string,
  instanceName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockKey = `${lockKeyPrefix}:${instanceName}`;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const start = Date.now();

  let acquired: 'OK' | null = null;
  while (acquired !== 'OK') {
    acquired = await redis.set(lockKey, token, 'PX', LOCK_TTL_MS, 'NX');
    if (acquired === 'OK') break;
    if (Date.now() - start > LOCK_MAX_WAIT_MS) break; // proceed without the lock rather than hang forever
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLLING_DELAY_MS));
  }

  try {
    return await fn();
  } finally {
    // Only delete if we still hold it - avoids deleting a lock someone else acquired after
    // ours expired (TTL) while fn() was still running.
    const current = await redis.get(lockKey);
    if (current === token) {
      await redis.del(lockKey);
    }
  }
}
