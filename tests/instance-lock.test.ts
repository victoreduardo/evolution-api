import assert from 'node:assert/strict';

import { withInstanceLock } from '../src/queues/instance-lock';

// Minimal fake ioredis - just enough of SET(...NX), GET, DEL to exercise the lock's atomicity.
// No real Redis needed for this test.
function createFakeRedis() {
  const store = new Map<string, string>();
  return {
    async set(key: string, value: string, _px: 'PX', _ms: number, nx: 'NX') {
      if (nx === 'NX' && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async del(key: string) {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    },
  } as any;
}

async function testSerializesSameInstance() {
  const redis = createFakeRedis();
  const events: string[] = [];

  const task = (label: string, ms: number) =>
    withInstanceLock(redis, 'lock', 'instance-a', async () => {
      events.push(`${label}:start`);
      await new Promise((r) => setTimeout(r, ms));
      events.push(`${label}:end`);
    });

  // Fire both "concurrently" - the second must wait for the first to release the lock.
  await Promise.all([task('A', 30), task('B', 5)]);

  assert.deepEqual(
    events,
    ['A:start', 'A:end', 'B:start', 'B:end'],
    'same-instance calls must serialize, not interleave',
  );
}

async function testParallelizesAcrossInstances() {
  const redis = createFakeRedis();
  const events: string[] = [];

  const task = (instanceName: string, label: string, ms: number) =>
    withInstanceLock(redis, 'lock', instanceName, async () => {
      events.push(`${label}:start`);
      await new Promise((r) => setTimeout(r, ms));
      events.push(`${label}:end`);
    });

  await Promise.all([task('instance-a', 'A', 30), task('instance-b', 'B', 5)]);

  // Different instances don't share a lock key, so B (shorter) finishes before A (longer),
  // proving they ran in parallel rather than queued behind each other.
  assert.deepEqual(events, ['A:start', 'B:start', 'B:end', 'A:end'], 'different instances must run in parallel');
}

async function testReleasesLockOnError() {
  const redis = createFakeRedis();

  await assert.rejects(
    withInstanceLock(redis, 'lock', 'instance-c', async () => {
      throw new Error('boom');
    }),
    /boom/,
  );

  // If the lock wasn't released, this second call would hang until the lock's max-wait timeout.
  const start = Date.now();
  await withInstanceLock(redis, 'lock', 'instance-c', async () => 'ok');
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `lock must be released even when fn() throws (took ${elapsed}ms)`);
}

async function testAtomicAcquireUnderRealConcurrency() {
  // Regression test for the actual bug this suite caught during development: a has()-then-set()
  // lock races when two callers check "is it free?" before either has written. This forces the
  // narrowest possible race window (no artificial delay between check and acquire) many times.
  const redis = createFakeRedis();
  let holders = 0;
  let maxConcurrentHolders = 0;

  const contend = () =>
    withInstanceLock(redis, 'lock', 'instance-d', async () => {
      holders += 1;
      maxConcurrentHolders = Math.max(maxConcurrentHolders, holders);
      // yield without a fixed delay, to maximize interleaving opportunities
      await Promise.resolve();
      holders -= 1;
    });

  await Promise.all(Array.from({ length: 20 }, contend));

  assert.equal(maxConcurrentHolders, 1, 'at most one holder must run fn() at a time, even under tight concurrency');
}

async function run() {
  await testSerializesSameInstance();
  await testParallelizesAcrossInstances();
  await testReleasesLockOnError();
  await testAtomicAcquireUnderRealConcurrency();
  console.log('instance-lock: OK');
}

run();
