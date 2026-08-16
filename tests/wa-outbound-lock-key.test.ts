import assert from 'node:assert/strict';

import { withInstanceLock } from '../src/queues/instance-lock';
import { createJid } from '../src/utils/createJid';

// Exercises the exact key composition wa-outbound.worker.ts uses:
// `${instanceName}:${createJid(number)}`. No fake worker/job plumbing needed -
// the property under test is entirely about what key withInstanceLock is called with.

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

function conversationKey(instanceName: string, number: string) {
  return `${instanceName}:${createJid(number)}`;
}

async function testDifferentRecipientsRunInParallel() {
  const redis = createFakeRedis();
  const events: string[] = [];

  const send = (label: string, number: string, ms: number) =>
    withInstanceLock(redis, 'wa-outbound-lock', conversationKey('instance-a', number), async () => {
      events.push(`${label}:start`);
      await new Promise((r) => setTimeout(r, ms));
      events.push(`${label}:end`);
    });

  // Same instance, two different recipients, fired back-to-back - must overlap, not queue.
  await Promise.all([send('A', '5511999990001', 30), send('B', '5511999990002', 5)]);

  assert.deepEqual(
    events,
    ['A:start', 'B:start', 'B:end', 'A:end'],
    'sends to different recipients on the same instance must run in parallel',
  );
}

async function testSameRecipientStillSerializes() {
  const redis = createFakeRedis();
  const events: string[] = [];

  const send = (label: string, number: string, ms: number) =>
    withInstanceLock(redis, 'wa-outbound-lock', conversationKey('instance-a', number), async () => {
      events.push(`${label}:start`);
      await new Promise((r) => setTimeout(r, ms));
      events.push(`${label}:end`);
    });

  // Same instance, same recipient - must stay strictly ordered, first-fired-first-run.
  await Promise.all([send('A', '5511999990001', 30), send('B', '5511999990001', 5)]);

  assert.deepEqual(
    events,
    ['A:start', 'A:end', 'B:start', 'B:end'],
    'sends to the same recipient must still serialize',
  );
}

async function testSameRecipientDifferentFormattingStillSerializes() {
  const redis = createFakeRedis();
  const events: string[] = [];

  const send = (label: string, number: string, ms: number) =>
    withInstanceLock(redis, 'wa-outbound-lock', conversationKey('instance-a', number), async () => {
      events.push(`${label}:start`);
      await new Promise((r) => setTimeout(r, ms));
      events.push(`${label}:end`);
    });

  // "Same" recipient, but formatted differently across the two calls (raw digits vs
  // +country/space/dash punctuated) - createJid must normalize both to the same key.
  await Promise.all([send('A', '5511987654321', 30), send('B', '+55 11 98765-4321', 5)]);

  assert.deepEqual(
    events,
    ['A:start', 'A:end', 'B:start', 'B:end'],
    'formatting variants of the same number must resolve to the same lock key',
  );
}

async function testSameRecipientDifferentInstancesRunInParallel() {
  const redis = createFakeRedis();
  const events: string[] = [];

  const send = (label: string, instanceName: string, ms: number) =>
    withInstanceLock(redis, 'wa-outbound-lock', conversationKey(instanceName, '5511999990001'), async () => {
      events.push(`${label}:start`);
      await new Promise((r) => setTimeout(r, ms));
      events.push(`${label}:end`);
    });

  // Same recipient number, but two different sending instances - instanceName in the key
  // keeps these independent, so they must run in parallel.
  await Promise.all([send('A', 'instance-a', 30), send('B', 'instance-b', 5)]);

  assert.deepEqual(
    events,
    ['A:start', 'B:start', 'B:end', 'A:end'],
    'same recipient from two different instances must run in parallel',
  );
}

async function run() {
  await testDifferentRecipientsRunInParallel();
  await testSameRecipientStillSerializes();
  await testSameRecipientDifferentFormattingStillSerializes();
  await testSameRecipientDifferentInstancesRunInParallel();
  console.log('wa-outbound-lock-key: OK');
}

run();
