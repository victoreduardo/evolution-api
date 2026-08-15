# BullMQ Message Pipeline (Inbound + Chatwoot + Outbound) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use forge:executing-plans to implement this plan task-by-task.

**Goal:** Move all three legs of the WhatsApp↔Chatwoot message pipeline — inbound processing, Chatwoot forwarding, and outbound sending — off the request/event thread and onto BullMQ queues with retry, timeout, and persistence, fixing the reported multi-minute delivery delays without losing any of the correctness guarantees the current synchronous/fire-and-forget code depends on.

**Architecture — three queues, one shared infrastructure layer:**

1. **`wa-inbound`** — `whatsapp.baileys.service.ts`'s `eventHandler()` enqueues `messages.upsert` and `messages.update` payloads instead of processing them inline inside `eventProcessingQueue` (`whatsapp.baileys.service.ts:1877`, the serialized per-instance promise chain that is the confirmed root cause of the reported delay). A worker does the DB/state processing that used to run there, and enqueues to `chatwoot-forward` whenever the instance needs to talk to Chatwoot.
2. **`chatwoot-forward`** — a generic sink, one job shape for any Chatwoot event (`messages.upsert`, `messages.read`, `messages.delete`, `send.message`, ...). Fed by both `wa-inbound` and `wa-outbound` workers. Replaces every in-scope direct/fire-and-forget `chatwootService.eventWhatsapp(...)` call with an enqueue, so all of them get retry/backoff/timeout instead of "hope it worked."
3. **`wa-outbound`** — every outbound send (HTTP API, chatbot integrations — Typebot/Dify/N8N/Flowise/EvoAI/EvolutionBot via `base-chatbot.service.ts` — and Chatwoot agent replies via `chatwoot.service.ts`) funnels through the single `sendMessageWithTyping` method already used by all of them. That method becomes a thin dispatcher: enqueue a job, return `{ jobId, status: 'queued' }` immediately. A worker does the real work (typing delay, validation, the actual `client.sendMessage`, DB persist, media upload) and enqueues the Chatwoot confirmation.

**Tech stack:** BullMQ + `ioredis` on the Redis already active via `CACHE_REDIS_ENABLED`. No new infrastructure. Single global kill switch `BULLMQ_ENABLED` (default `false` — opt-in, since this changes the outbound API response contract) gates all three queues; when off, every code path falls back to today's exact behavior (inline synchronous chatwoot calls, inline synchronous send, fire-and-forget post-send side effects).

**Scope:** Baileys channel only (`whatsapp.baileys.service.ts`). Meta Business API and Evolution channel have their own separate `sendMessageWithTyping` implementations — not touched here; same pattern can be replicated later if needed. `messaging-history.set` (initial history sync) and low-volume lifecycle events (QR code, connection open/close, contacts-update-from-history) are **not** moved to a queue — flagged as blocking-but-lower-priority in the investigation, kept out to bound this plan's size. The `chatwoot-forward` queue's generic shape means extending to them later is additive, not a redesign.

**Breaking change, confirmed acceptable:** `sendText`, `sendMedia`, and every other `/message/send*` endpoint, plus every chatbot-integration and Chatwoot-agent-reply send, stop returning the real sent-message payload synchronously. They return a queued-job stub. Real send confirmation arrives via the existing `Events.SEND_MESSAGE` webhook, same as today.

---

## Critical constraints found during investigation — do not violate these

1. **Never pre-generate the WhatsApp `messageId`.** `whatsapp.baileys.service.ts:2155` has an explicit comment: generating `messageId` before calling Baileys' internal send breaks WhatsApp's ability to identify the message source. The `messageId` field must stay `undefined` until the `wa-outbound` worker calls the real `sendMessage`, which lets Baileys generate it (existing behavior, unchanged). The value returned at enqueue time is **our own BullMQ job id**, never a WhatsApp message id.

2. **Buffers/`Uint8Array` do not survive `JSON.stringify`.** `prepareMessage()` (`whatsapp.baileys.service.ts:4737`) converts message content through `deserializeMessageBuffers()` (`whatsapp.baileys.service.ts:4698`), which produces `Uint8Array` fields (media keys, hashes) required intact for Chatwoot's media decrypt path. BullMQ serializes job data with `JSON.stringify`/`parse`, which turns `Uint8Array` into a plain indexed object, silently corrupting media. Every queue in this plan uses the same buffer-safe serializer (Task 3) — never enqueue a raw `messageRaw`/WAMessage without running it through `toJobSafe()` first.

3. **`sendMessageWithTyping` has non-HTTP callers that expect the real sent-message shape back**, not just controller pass-throughs:
   - `base-chatbot.service.ts:213,220,291` and `typebot.service.ts:328,343,358,485,560` — chatbot flows sending bot replies. These `await` but don't use the return value, so switching to a queued stub doesn't break them *functionally*, but the queue must preserve **per-instance send order** (bot flows send message 1, 2, 3 in sequence — they must still arrive in that order) — see Task 8's per-instance lock.
   - `chatwoot.service.ts` has exactly **two** call sites that need the real sent-message data — not four; `:2032` (`await waInstance?.textMessage(data);`, no `isIntegration` flag, template-auto-reply flow) does **not** link and is out of scope:
     - **Attachment block, `chatwoot.service.ts:1900-1934`**: either `contactMessage(...)` (`:1906`, contact-card attachments) or `sendAttachment(...)` (`:1918`, which internally calls `mediaMessage`/`audioWhatsapp` at `:1663`/`:1688`) produces `messageSent`, then `updateChatwootMessageId(...)` is called once at `:1923` for both branches.
     - **Text block, `chatwoot.service.ts:1937-1968`**: `textMessage(data, true)` at `:1948` produces `messageSent`, then `updateChatwootMessageId(...)` is called at `:1957`.
   - Both blocks already have the link data in scope *before* calling `waInstance`: `{ messageId: body.id, inboxId: body.inbox?.id, conversationId: body.conversation?.id, contactInboxSourceId: body.conversation?.contact_inbox?.source_id }` (`chatwoot.service.ts:1927-1932` and `:1961-1966`) — this is the exact shape of the (currently unexported) `ChatwootMessage` interface at `chatwoot.service.ts:36-42`. Export it and pass it straight through as `chatwootLinkContext` — see Task 9, Step 4.

4. **Existing per-conversation locking in `createConversation`** (`chatwoot.service.ts:703-814`, cache-based lock with 5s poll timeout) already makes concurrent `chatwoot-forward` workers safe for conversation creation — reused as-is, not modified.

5. **`updateChatwootMessageId()` (`chatwoot.service.ts:2043`) needs the `Message` DB row to already exist** — it's a plain `UPDATE ... WHERE "key"->>'id' = ...`, silently a no-op if the row isn't there yet. It only works if called *after* `prismaRepository.message.create(...)` for that send has completed. Today's fire-and-forget `processMessageAsync` (not awaited) already races this for the Chatwoot agent-reply path — Task 9 fixes it by awaiting the persist step before the link update whenever `chatwootLinkContext` is involved, without regressing the fire-and-forget optimization for ordinary sends when the queue is disabled (see Task 9, Step 2).

6. **`updateChatwootMessageId` is `private` today** (`chatwoot.service.ts:2043`) — it's only ever called from within `chatwoot.service.ts` itself. It needs to become `public` since both the `chatwoot-forward` worker (Task 5) and `BaileysStartupService.executeSendMessage` (Task 9) — different classes — need to call it directly.

---

## Part A — Shared infrastructure

### Task 1: Dependencies

**Files:** Modify `package.json`

```bash
npm install bullmq ioredis
```

Verify: `grep -E '"bullmq"|"ioredis"' package.json` shows both in `dependencies`.

Commit: `chore: add bullmq and ioredis dependencies`

---

### Task 2: Config — `BULLMQ_ENABLED` and per-queue settings

**Files:**
- Modify: `src/config/env.config.ts`
- Modify: `env.example`

**Step 1: Add a new top-level `BullMQ` config type**, near the other integration types (e.g. after `export type Chatwoot = {...}` at `env.config.ts:323-336`):

```typescript
export type BullMQConfig = {
  ENABLED: boolean;
  QUEUES: {
    WA_INBOUND: { CONCURRENCY: number };
    CHATWOOT_FORWARD: { CONCURRENCY: number; ATTEMPTS: number; TIMEOUT_MS: number };
    WA_OUTBOUND: { CONCURRENCY: number; ATTEMPTS: number; TIMEOUT_MS: number };
  };
};
```

Add `BULLMQ: BullMQConfig;` to the main config object type (find it near `CHATWOOT: Chatwoot;` at `env.config.ts:420` and add alongside).

**Step 2: Add env parsing**, near the `CHATWOOT:` block (`env.config.ts:822-834`):

```typescript
      BULLMQ: {
        ENABLED: process.env?.BULLMQ_ENABLED === 'true',
        QUEUES: {
          WA_INBOUND: {
            CONCURRENCY: Number.parseInt(process.env?.BULLMQ_WA_INBOUND_CONCURRENCY) || 10,
          },
          CHATWOOT_FORWARD: {
            CONCURRENCY: Number.parseInt(process.env?.BULLMQ_CHATWOOT_FORWARD_CONCURRENCY) || 5,
            ATTEMPTS: Number.parseInt(process.env?.BULLMQ_CHATWOOT_FORWARD_ATTEMPTS) || 5,
            TIMEOUT_MS: Number.parseInt(process.env?.BULLMQ_CHATWOOT_FORWARD_TIMEOUT_MS) || 30000,
          },
          WA_OUTBOUND: {
            CONCURRENCY: Number.parseInt(process.env?.BULLMQ_WA_OUTBOUND_CONCURRENCY) || 5,
            ATTEMPTS: Number.parseInt(process.env?.BULLMQ_WA_OUTBOUND_ATTEMPTS) || 3,
            TIMEOUT_MS: Number.parseInt(process.env?.BULLMQ_WA_OUTBOUND_TIMEOUT_MS) || 60000,
          },
        },
      },
```

`ENABLED` defaults to `false` (unset ≠ `'true'`) — explicit opt-in, per the decision to default off since this changes the outbound API response contract.

`WA_OUTBOUND.ATTEMPTS` defaults lower (3, not 5) — retrying an actual WhatsApp send has side effects (don't want 5 duplicate sends if Baileys itself is flaky); tune down further in Task 8 if duplicate-send risk shows up in testing.

**Step 3: Document in `env.example`**, after the `CHATWOOT_*` block:

```
# BullMQ message pipeline (wa-inbound, chatwoot-forward, wa-outbound queues)
BULLMQ_ENABLED=false
BULLMQ_WA_INBOUND_CONCURRENCY=10
BULLMQ_CHATWOOT_FORWARD_CONCURRENCY=5
BULLMQ_CHATWOOT_FORWARD_ATTEMPTS=5
BULLMQ_CHATWOOT_FORWARD_TIMEOUT_MS=30000
BULLMQ_WA_OUTBOUND_CONCURRENCY=5
BULLMQ_WA_OUTBOUND_ATTEMPTS=3
BULLMQ_WA_OUTBOUND_TIMEOUT_MS=60000
```

**Step 4:** `npx tsc --noEmit -p tsconfig.json` — no new errors.

Commit: `feat(config): add BULLMQ_ENABLED and per-queue settings`

---

### Task 3: Shared BullMQ Redis connection

**Files:** Create `src/queues/bullmq-connection.ts`

```typescript
import { BullMQConfig, Cache, configService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import IORedis from 'ioredis';

const logger = new Logger('BullMQConnection');

let connection: IORedis | null = null;

export function isBullMQEnabled(): boolean {
  return configService.get<BullMQConfig>('BULLMQ').ENABLED && configService.get<Cache>('CACHE').REDIS.ENABLED;
}

export function getBullMQConnection(): IORedis {
  if (connection) return connection;

  const { URI } = configService.get<Cache>('CACHE').REDIS;

  // maxRetriesPerRequest must be null: required by BullMQ for its blocking commands.
  connection = new IORedis(URI, { maxRetriesPerRequest: null });

  connection.on('error', (err) => logger.error(`BullMQ redis connection error: ${err.message}`));
  connection.on('ready', () => logger.verbose('BullMQ redis connection ready'));

  return connection;
}
```

Check the exported name of the cache config type before writing the import:
```bash
grep -n "export type Cache " src/config/env.config.ts
```
Adjust the import if it's named differently (e.g. `CacheConf`).

Verify: `npx tsc --noEmit -p tsconfig.json`

Commit: `feat(queues): add shared BullMQ redis connection and enabled-check`

---

### Task 4: Buffer-safe job serializer

Generic — used by all three queues, not Chatwoot-specific, so it lives at the shared `src/queues/` level this time (not nested under the chatwoot module as in the earlier draft).

**Files:**
- Create: `src/queues/job-serializer.ts`
- Test: `test/job-serializer.test.ts`

**Step 1: Write the failing test**

```typescript
// test/job-serializer.test.ts
import assert from 'node:assert/strict';
import { toJobSafe, fromJobSafe } from '../src/queues/job-serializer';

function run() {
  const original = {
    key: { id: 'ABC123', remoteJid: '5511999999999@s.whatsapp.net' },
    message: { imageMessage: { mediaKey: new Uint8Array([1, 2, 3, 250, 255]), caption: 'oi' } },
    nested: { list: [new Uint8Array([9, 8]), { deeper: new Uint8Array([7]) }] },
  };

  const restored = fromJobSafe(JSON.parse(JSON.stringify(toJobSafe(original))));

  assert.ok(restored.message.imageMessage.mediaKey instanceof Uint8Array);
  assert.deepEqual(Array.from(restored.message.imageMessage.mediaKey), [1, 2, 3, 250, 255]);
  assert.ok(restored.nested.list[0] instanceof Uint8Array);
  assert.ok(restored.nested.list[1].deeper instanceof Uint8Array);
  assert.equal(restored.message.imageMessage.caption, 'oi');
  assert.equal(restored.key.id, 'ABC123');

  console.log('job-serializer: OK');
}

run();
```

**Step 2:** `npx tsx test/job-serializer.test.ts` — fails, module doesn't exist.

**Step 3: Implement**

```typescript
// src/queues/job-serializer.ts
const BUFFER_MARKER = '__u8__';

export function toJobSafe(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { [BUFFER_MARKER]: Buffer.from(value).toString('base64') };
  }
  if (Array.isArray(value)) return value.map(toJobSafe);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) out[key] = toJobSafe(val);
    return out;
  }
  return value;
}

export function fromJobSafe(value: unknown): any {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (typeof obj[BUFFER_MARKER] === 'string' && Object.keys(obj).length === 1) {
      return new Uint8Array(Buffer.from(obj[BUFFER_MARKER] as string, 'base64'));
    }
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) out[key] = fromJobSafe(val);
    return out;
  }
  if (Array.isArray(value)) return value.map(fromJobSafe);
  return value;
}
```

**Step 4:** `npx tsx test/job-serializer.test.ts` → `job-serializer: OK`

Commit: `feat(queues): add buffer-safe job serialization helper`

---

## Part B — `chatwoot-forward` (generic Chatwoot event queue)

### Task 5: Queue + worker

**Files:**
- Create: `src/api/integrations/chatbot/chatwoot/queues/chatwoot-forward.queue.ts`
- Create: `src/api/integrations/chatbot/chatwoot/queues/chatwoot-forward.worker.ts`

**Queue** (generic over `event`, unlike the earlier upsert-only draft):

```typescript
// chatwoot-forward.queue.ts
import { BullMQConfig, configService } from '@config/env.config';
import { Queue } from 'bullmq';

import { getBullMQConnection, isBullMQEnabled } from '../../../../../queues/bullmq-connection';
import { toJobSafe } from '../../../../../queues/job-serializer';

export const CHATWOOT_FORWARD_QUEUE_NAME = 'chatwoot-forward';

export type ChatwootForwardJobData = {
  event: string; // e.g. 'messages.upsert' | 'messages.read' | 'messages.delete' | 'send.message'
  instanceName: string;
  instanceId: string;
  body: unknown; // buffer-safe, run through toJobSafe()
  // present only when this forward originates from a wa-outbound send that needs
  // the Chatwoot message record linked back to the real WhatsApp message afterwards
  chatwootLinkContext?: ChatwootMessage;
};

let queue: Queue<ChatwootForwardJobData> | null = null;

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

export { isBullMQEnabled as isChatwootForwardQueueAvailable };

export async function enqueueChatwootEvent(
  data: Omit<ChatwootForwardJobData, 'body'> & { body: unknown },
): Promise<void> {
  await getQueue().add('forward', { ...data, body: toJobSafe(data.body) });
}
```

**Worker** — timeout guard included because `@figuro/chatwoot-sdk`'s `ChatwootAPIConfig` has no `timeout` option (confirmed by inspecting `node_modules/@figuro/chatwoot-sdk/dist/core/ChatwootAPI.d.ts`), so a hung HTTP call would otherwise hang the job forever:

```typescript
// chatwoot-forward.worker.ts
import { BullMQConfig, configService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { Job, Worker } from 'bullmq';

import { getBullMQConnection } from '../../../../../queues/bullmq-connection';
import { fromJobSafe } from '../../../../../queues/job-serializer';
import { ChatwootService } from '../services/chatwoot.service';
import { CHATWOOT_FORWARD_QUEUE_NAME, ChatwootForwardJobData } from './chatwoot-forward.queue';

const logger = new Logger('ChatwootForwardWorker');

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Chatwoot forward timed out after ${ms}ms`)), ms)),
  ]);
}

export function startChatwootForwardWorker(chatwootService: ChatwootService): Worker<ChatwootForwardJobData> {
  const { CONCURRENCY, TIMEOUT_MS } = configService.get<BullMQConfig>('BULLMQ').QUEUES.CHATWOOT_FORWARD;

  const worker = new Worker<ChatwootForwardJobData>(
    CHATWOOT_FORWARD_QUEUE_NAME,
    async (job: Job<ChatwootForwardJobData>) => {
      const { event, instanceName, instanceId, body, chatwootLinkContext } = job.data;

      const sent = await withTimeout(
        chatwootService.eventWhatsapp(event, { instanceName, instanceId }, fromJobSafe(body)),
        TIMEOUT_MS,
      );

      if (sent?.id && chatwootLinkContext) {
        // see Task 9 — links a wa-outbound send back to the originating Chatwoot message
        await chatwootService.updateChatwootMessageId(sent, chatwootLinkContext, { instanceName, instanceId });
      }
    },
    { connection: getBullMQConnection(), concurrency: CONCURRENCY },
  );

  worker.on('failed', (job, err) =>
    logger.error(`Chatwoot forward job ${job?.id} (event=${job?.data?.event}) failed (attempt ${job?.attemptsMade}): ${err.message}`),
  );

  return worker;
}
```

Before finalizing, confirm `updateChatwootMessageId`'s actual signature (Task 9 defines its new shape) and adjust this call accordingly — Tasks in this plan are sequenced so Task 9 exists before this worker is wired into `server.module.ts` (Task 11), but the file itself is written here for locality.

Verify: `npx tsc --noEmit -p tsconfig.json`

Commit: `feat(chatwoot): add generic chatwoot-forward queue and worker`

---

### Task 6: Replace direct/fire-and-forget Chatwoot calls with enqueues (inbound side)

**Files:** Modify `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts`

This task's changes get physically relocated into the `wa-inbound` worker in Task 7 — do this replacement first, in place, so it's easy to diff/verify, then move the whole block in Task 7.

**Step 1: `messages.upsert` new-message forward** (`whatsapp.baileys.service.ts:1326-1342`) — replace the body of the `if (shouldForwardToChatwoot)` block (see Task 7 for full context) so it calls:
```typescript
await enqueueChatwootEvent({
  event: Events.MESSAGES_UPSERT,
  instanceName: this.instance.name,
  instanceId: this.instanceId,
  body: messageRaw,
});
```
instead of `await this.chatwootService.eventWhatsapp(...)`. Note this drops the old synchronous `chatwootSentMessage.id` → `messageRaw.chatwootMessageId` assignment (lines 1337-1341) — that patch now has to happen *after* the DB row exists, from inside the `chatwoot-forward` worker. Task 7 handles the DB update.

**Step 2: `messages.upsert` edited-message forward** (`whatsapp.baileys.service.ts:1126-1131`):
```typescript
if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled)
  await enqueueChatwootEvent({
    event: 'messages.edit',
    instanceName: this.instance.name,
    instanceId: this.instanceId,
    body: editedMessage,
  });
```

**Step 3: `messages.update` read-confirmation** (`whatsapp.baileys.service.ts:1589-1597`) — this is the call you flagged (confirms delivery/read status back to Chatwoot the same way an inbound message does):
```typescript
if (status[update.status] === 'READ' && key.fromMe) {
  if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
    await enqueueChatwootEvent({
      event: 'messages.read',
      instanceName: this.instance.name,
      instanceId: this.instanceId,
      body: { key },
    });
  }
}
```

**Step 4: `messages.update` delete-confirmation** (`whatsapp.baileys.service.ts:1661-1667`):
```typescript
if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
  await enqueueChatwootEvent({
    event: Events.MESSAGES_DELETE,
    instanceName: this.instance.name,
    instanceId: this.instanceId,
    body: { key },
  });
}
```

**Step 5: Add fallback wrapper.** All four call sites above must fall back to today's exact direct call when `BULLMQ_ENABLED=false`. Rather than repeating the `if (isChatwootForwardQueueAvailable()) ... else ...` at each of the 4 sites, add one private helper on the class (near `prepareMessage`):

```typescript
private async dispatchChatwootEvent(event: string, body: any): Promise<any> {
  if (isChatwootForwardQueueAvailable()) {
    await enqueueChatwootEvent({ event, instanceName: this.instance.name, instanceId: this.instanceId, body });
    return null; // no synchronous result when queued — callers must not depend on it
  }
  return this.chatwootService.eventWhatsapp(
    event,
    { instanceName: this.instance.name, instanceId: this.instanceId },
    body,
  );
}
```

Use `await this.dispatchChatwootEvent(event, body)` at all 4 call sites instead of the raw enqueue call shown above — simpler and consistent. Add the import:
```typescript
import { enqueueChatwootEvent, isChatwootForwardQueueAvailable } from '@api/integrations/chatbot/chatwoot/queues/chatwoot-forward.queue';
```

**Step 6:** `npx tsc --noEmit -p tsconfig.json`

Commit: `feat(baileys): route chatwoot forwarding through queue with sync fallback`

---

## Part C — `wa-inbound` (Baileys message/status processing queue)

### Task 7: Queue + worker, and rewire `eventHandler()`

This is the change that fixes the originally reported bug: `eventProcessingQueue` (`whatsapp.baileys.service.ts:1877`) stops doing DB writes and Chatwoot calls inline for `messages.upsert`/`messages.update` — it only enqueues and moves on immediately.

**Files:**
- Create: `src/api/integrations/channel/whatsapp/queues/wa-inbound.queue.ts`
- Create: `src/api/integrations/channel/whatsapp/queues/wa-inbound.worker.ts`
- Modify: `whatsapp.baileys.service.ts:1910-1920` (the `eventHandler` dispatch) and the `messageHandle` object itself

**Step 1: Queue definition**

```typescript
// wa-inbound.queue.ts
import { BullMQConfig, configService } from '@config/env.config';
import { Queue } from 'bullmq';
import { BaileysEventMap } from 'baileys';

import { getBullMQConnection, isBullMQEnabled } from '../../../../queues/bullmq-connection';
import { toJobSafe } from '../../../../queues/job-serializer';

export const WA_INBOUND_QUEUE_NAME = 'wa-inbound';

export type WaInboundJobData = {
  type: 'messages.upsert' | 'messages.update';
  instanceName: string;
  payload: unknown; // buffer-safe
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
  // FIFO per instance matters here (chat/unread-count logic assumes order) — jobs for the
  // same instance must be added to the queue in the exact order eventHandler received them.
  // BullMQ preserves add-order for processing when concurrency allows it to catch up; see
  // Step 4 for the per-instance lock that guarantees it under concurrency > 1.
  await getQueue().add(data.type, { ...data, payload: toJobSafe(data.payload) });
}
```

**Step 2: Move `messageHandle['messages.upsert']` and `messageHandle['messages.update']` into the worker.**

These are large (`whatsapp.baileys.service.ts:1082-1557` and `:1558-1733`, ~650 lines total) and reference many `this.*` methods (`this.prismaRepository`, `this.getMessage`, `this.prepareMessage`, `this.baileysCache`, `this.updateMessagesReadedByTimestamp`, etc). Rather than copy-pasting them into a standalone function (which would need every dependency re-threaded), keep them as **instance methods on `BaileysStartupService`** — the worker just needs to call back into the right instance:

```typescript
// wa-inbound.worker.ts
import { Logger } from '@config/logger.config';
import { BullMQConfig, configService } from '@config/env.config';
import { Job, Worker } from 'bullmq';

import { getBullMQConnection } from '../../../../queues/bullmq-connection';
import { fromJobSafe } from '../../../../queues/job-serializer';
import { WAMonitoringService } from '@api/services/monitor.service';
import { WA_INBOUND_QUEUE_NAME, WaInboundJobData } from './wa-inbound.queue';

const logger = new Logger('WaInboundWorker');

// One BullMQ job at a time per instance — the DB/state logic in messageHandle assumes
// events for a given instance arrive and are processed in order (unread counts, chat
// upsert dedupe, poll-vote aggregation). Concurrency across *different* instances is
// still parallel; this only serializes within one instance. Same lock pattern already
// used in chatwoot.service.ts's createConversation (chatwoot.service.ts:703-814).
async function withInstanceLock<T>(waMonitor: WAMonitoringService, instanceName: string, fn: () => Promise<T>): Promise<T> {
  const cache = waMonitor.waInstances[instanceName]?.baileysCache; // confirm actual accessor name — see Step 3 note
  const lockKey = `wa-inbound-lock:${instanceName}`;
  const pollMs = 100;
  const maxWaitMs = 30000;
  const start = Date.now();
  while (await cache.get(lockKey)) {
    if (Date.now() - start > maxWaitMs) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  await cache.set(lockKey, true, 30);
  try {
    return await fn();
  } finally {
    await cache.delete(lockKey);
  }
}

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

      await withInstanceLock(waMonitor, instanceName, () => instance.processInboundEvent(type, payload, settings));
    },
    { connection: getBullMQConnection(), concurrency: CONCURRENCY },
  );

  worker.on('failed', (job, err) =>
    logger.error(`wa-inbound job ${job?.id} (${job?.data?.type}, instance=${job?.data?.instanceName}) failed: ${err.message}`),
  );

  return worker;
}
```

**Step 3: Cache accessor — already fine.** `baileysCache` is already `public readonly baileysCache: CacheService` (`whatsapp.baileys.service.ts:236`, constructor-injected) — no visibility change needed. `withInstanceLock` (and `wa-outbound`'s copy, Task 8) reach it directly as `waMonitor.waInstances[instanceName].baileysCache`.

**Step 4: Add `processInboundEvent` and the enqueue dispatch on `BaileysStartupService`.**

Add a new public method that's just a router to the existing (now slightly modified, per Task 6) handlers:

```typescript
public async processInboundEvent(
  type: 'messages.upsert' | 'messages.update',
  payload: any,
  settings: any,
): Promise<void> {
  if (type === 'messages.upsert') {
    await this.messageHandle['messages.upsert'](payload, settings);
  } else {
    await this.messageHandle['messages.update'](payload, settings);
  }
}
```

Then in `eventHandler()`, replace the direct calls (`whatsapp.baileys.service.ts:1915-1925`):

```typescript
            if (events['messages.upsert']) {
              const payload = events['messages.upsert'];
              if (isWaInboundQueueAvailable()) {
                await enqueueWaInbound({ type: 'messages.upsert', instanceName: this.instance.name, payload, settings });
              } else {
                await this.messageHandle['messages.upsert'](payload, settings);
              }
            }

            if (events['messages.update']) {
              const payload = events['messages.update'];
              if (isWaInboundQueueAvailable()) {
                await enqueueWaInbound({ type: 'messages.update', instanceName: this.instance.name, payload, settings });
              } else {
                await this.messageHandle['messages.update'](payload, settings);
              }
            }
```

This is the actual fix: `eventProcessingQueue` now does a Redis `LPUSH`-equivalent (milliseconds) instead of full message processing + a Chatwoot HTTP round-trip, for both new messages and status updates.

**Step 5: DB-patch after async Chatwoot forward.** Since `dispatchChatwootEvent` (Task 6, Step 5) now returns `null` when queued, the old synchronous `messageRaw.chatwootMessageId = ...` assignment before `prismaRepository.message.create(...)` (`whatsapp.baileys.service.ts:1337-1341`) no longer has data to write. Move that DB patch into the `chatwoot-forward` worker (Task 5) using the `messageId` DB row id — the `chatwoot-forward` job payload needs an optional `messageDbId` field (add to `ChatwootForwardJobData` in Task 5) that `messages.upsert`'s enqueue call sets to `msg.id` *after* `prismaRepository.message.create(...)` runs (`whatsapp.baileys.service.ts:1358`). Reorder: build `messageRaw` → create DB row → enqueue chatwoot event with `messageDbId: msg.id` → chatwoot-forward worker does `prismaRepository.message.update({ where: { id: messageDbId }, data: { chatwootMessageId: sent.id, chatwootInboxId: sent.inbox_id, chatwootConversationId: sent.conversation_id } })` when `sent?.id` and `messageDbId` are both present.

**Step 6:** `npx tsc --noEmit -p tsconfig.json`

**Step 7: Manual verification** — see Task 12 for the full inbound smoke test.

Commit: `feat(baileys): move messages.upsert/update processing to wa-inbound queue`

---

## Part D — `wa-outbound` (send pipeline)

### Task 8: Queue + worker + per-instance ordering lock

**Files:**
- Create: `src/api/integrations/channel/whatsapp/queues/wa-outbound.queue.ts`
- Create: `src/api/integrations/channel/whatsapp/queues/wa-outbound.worker.ts`

**Job payload** — must carry everything `sendMessageWithTyping`'s current body (`whatsapp.baileys.service.ts:2289-2486`) needs: `number`, `message`, `options`, `isIntegration`, plus the optional `chatwootLinkContext` from constraint #3.

```typescript
// wa-outbound.queue.ts
import { BullMQConfig, configService } from '@config/env.config';
import { Queue } from 'bullmq';

import { getBullMQConnection, isBullMQEnabled } from '../../../../queues/bullmq-connection';
import { toJobSafe } from '../../../../queues/job-serializer';

export const WA_OUTBOUND_QUEUE_NAME = 'wa-outbound';

export type WaOutboundJobData = {
  instanceName: string;
  number: string;
  message: unknown; // buffer-safe
  options?: unknown;
  isIntegration: boolean;
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
  const job = await getQueue().add('send', { ...data, message: toJobSafe(data.message) });
  return { jobId: job.id as string };
}
```

**Worker** — same per-instance lock pattern as `wa-inbound` (Task 7, Step 2/3), reused via the same `withInstanceLock` helper (extract it to a shared file, e.g. `src/queues/instance-lock.ts`, since both `wa-inbound` and `wa-outbound` need it — don't duplicate it):

```typescript
// wa-outbound.worker.ts
import { Logger } from '@config/logger.config';
import { BullMQConfig, configService } from '@config/env.config';
import { Job, Worker } from 'bullmq';

import { getBullMQConnection } from '../../../../queues/bullmq-connection';
import { fromJobSafe } from '../../../../queues/job-serializer';
import { withInstanceLock } from '../../../../queues/instance-lock';
import { WAMonitoringService } from '@api/services/monitor.service';
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
      if (!instance) throw new Error(`Instance ${instanceName} not found`); // let BullMQ retry — instance may reconnect

      await withInstanceLock(waMonitor, instanceName, () =>
        withTimeout(instance.executeSendMessage(number, message, options, isIntegration, chatwootLinkContext, true), TIMEOUT_MS),
      );
    },
    { connection: getBullMQConnection(), concurrency: CONCURRENCY },
  );

  worker.on('failed', (job, err) =>
    logger.error(`wa-outbound job ${job?.id} (instance=${job?.data?.instanceName}) failed (attempt ${job?.attemptsMade}): ${err.message}`),
  );

  return worker;
}
```

Note `WA_OUTBOUND.ATTEMPTS` default is 3, not 5 (Task 2) — a retried send is a real duplicate WhatsApp message if the first attempt actually succeeded but only the DB-write/webhook step failed after. This plan does not solve exactly-once delivery (out of scope — flagged in Known Limitations); keeping attempts low bounds the damage. If duplicate sends show up in testing, consider making the DB-write the only retried step and treating a successful `client.sendMessage` as non-retriable — that's a bigger change, revisit only if the simple version proves insufficient.

Commit: `feat(baileys): add wa-outbound queue, worker, and shared instance lock`

(Extracting `withInstanceLock` to `src/queues/instance-lock.ts`: move the implementation sketched in Task 7 Step 2 there, parameterized by lock key prefix, and have both workers import it. Do this as part of this task, then go back and update Task 7's worker to import from there instead of a local copy.)

---

### Task 9: Split `sendMessageWithTyping` into dispatcher + `executeSendMessage`

**Files:** Modify `whatsapp.baileys.service.ts:2289-2486`

**Step 1:** Rename the existing method to `public async executeSendMessage(...)` (same signature, same body, just visibility changed to `public` and name changed) — add two parameters: `chatwootLinkContext?: { chatwootMessageId: number; chatwootConversationId: number }` and `awaitSideEffects = false`.

**Step 2: Await `processMessageAsync` only where ordering correctness requires it — don't regress the fallback path's response latency.**

`updateChatwootMessageId()` (`chatwoot.service.ts:2043`) does `UPDATE "Message" ... WHERE "key"->>'id' = ...` — a no-op if that row doesn't exist yet. `processMessageAsync` (`whatsapp.baileys.service.ts:2476`, fire-and-forget, not awaited) is what does the `prismaRepository.message.create(...)` (`whatsapp.baileys.service.ts:2529`) that creates that row. Calling `updateChatwootMessageId` right after `sendDataWebhook`, as originally sketched, races that DB write and can silently affect 0 rows — a real bug already latent in today's code for the agent-reply path, not something newly introduced here.

The fix is **not** "always await `processMessageAsync`" — that would regress the `BULLMQ_ENABLED=false` fallback path, where `processMessageAsync` being fire-and-forget is a deliberate, already-shipped optimization to keep the synchronous HTTP response fast (this exact plan's whole premise is not to make that path worse). The two contexts need different treatment:

- **Inside the `wa-outbound` worker** (queue enabled): await everything. There's no HTTP response to protect — the job function's promise resolving *is* "done," and BullMQ's retry-on-failure only means anything if a persist failure actually fails the job.
- **Inline fallback** (queue disabled): keep today's fire-and-forget for the general case, but still await specifically when `chatwootLinkContext` is present — that's the one case that's actually broken by the race, independent of queueing.

Add a parameter to `executeSendMessage` for this: `awaitSideEffects = false`. The `wa-outbound` worker (Task 8) passes `true`; the inline fallback in `sendMessageWithTyping` (Step 3 below) passes nothing (defaults `false`). Replace the existing fire-and-forget call:

```typescript
// was: this.processMessageAsync(messageRaw, messageSent, isMedia, isIntegration).catch((error) => {...});
if (awaitSideEffects || chatwootLinkContext) {
  const msg = await this.persistSentMessageAndSideEffects(messageRaw, messageSent, isMedia, isIntegration);
  if (chatwootLinkContext && msg?.id) {
    await this.dispatchChatwootLinkUpdate(messageRaw, chatwootLinkContext);
  }
} else {
  this.persistSentMessageAndSideEffects(messageRaw, messageSent, isMedia, isIntegration).catch((error) => {
    this.logger.error('Error processing message async:', error);
  });
}
```

`persistSentMessageAndSideEffects` is `processMessageAsync` renamed (same body), with one change: `return msg;` added at the end of its `SAVE_DATA.NEW_MESSAGE` branch so the caller above can reach `msg.id` (currently `whatsapp.baileys.service.ts:2529`'s `msg` falls out of scope unreturned).

Add the corresponding private helper:
```typescript
private async dispatchChatwootLinkUpdate(
  messageRaw: any,
  chatwootLinkContext: { chatwootMessageId: number; chatwootConversationId: number },
): Promise<void> {
  try {
    await this.chatwootService.updateChatwootMessageId(
      messageRaw,
      chatwootLinkContext,
      { instanceName: this.instance.name, instanceId: this.instanceId },
    );
  } catch (error) {
    this.logger.error(`Failed to link chatwoot message id: ${error}`);
  }
}
```
Check `updateChatwootMessageId`'s actual current signature first (`grep -n "updateChatwootMessageId" src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts`) and adjust the call to match — do not assume the signature above is exactly right without checking.

**Step 3:** Write the new thin `sendMessageWithTyping`:
```typescript
private async sendMessageWithTyping<T = proto.IMessage>(
  number: string,
  message: T,
  options?: Options,
  isIntegration = false,
  chatwootLinkContext?: { chatwootMessageId: number; chatwootConversationId: number },
) {
  if (isWaOutboundQueueAvailable()) {
    const { jobId } = await enqueueWaOutbound({
      instanceName: this.instance.name,
      number,
      message,
      options,
      isIntegration,
      chatwootLinkContext,
    });
    return { jobId, status: 'queued' as const };
  }

  return this.executeSendMessage(number, message, options, isIntegration, chatwootLinkContext);
}
```

Add the import:
```typescript
import { enqueueWaOutbound, isWaOutboundQueueAvailable } from './queues/wa-outbound.queue';
```

**Step 4: Fix the 2 `chatwoot.service.ts` call sites from constraint #3** so they pass `chatwootLinkContext` in and stop depending on the return value for linking. Verified against live code (not just sketched):

**4a. Export the link-context type.** `chatwoot.service.ts:36-42` has a local, unexported `interface ChatwootMessage { messageId?: number; inboxId?: number; conversationId?: number; contactInboxSourceId?: string; isRead?: boolean; }`. Add `export` to it — this is the real shape (`messageId`/`conversationId`, not `chatwootMessageId`/`chatwootConversationId`) — and use `ChatwootMessage` as the `chatwootLinkContext` type everywhere in this plan (already corrected above and in Tasks 5/8/9's code).

**4b. Make `updateChatwootMessageId` public.** Change `private async updateChatwootMessageId(` to `public async updateChatwootMessageId(` at `chatwoot.service.ts:2043`. No other signature change needed — `(message: MessageModel, chatwootMessageIds: ChatwootMessage, instance: InstanceDto)` is already exactly the shape `executeSendMessage`'s `dispatchChatwootLinkUpdate` (Step 2 above) and the `chatwoot-forward` worker (Task 5) need to call.

**4c. Thread `chatwootLinkContext` through the attachment block** (`chatwoot.service.ts:1900-1934`). Add an optional `chatwootLinkContext?: ChatwootMessage` parameter to `contactMessage(data: SendContactDto, isIntegration = false, chatwootLinkContext?: ChatwootMessage)` on `BaileysStartupService` (`whatsapp.baileys.service.ts:3533`) and forward it into its `sendMessageWithTyping(data.number, { ...message }, {}, isIntegration, chatwootLinkContext)` call. Do the same for `sendAttachment(waInstance, number, media, caption?, options?, chatwootLinkContext?: ChatwootMessage)` in `chatwoot.service.ts:1620`, forwarding it into its internal `waInstance.audioWhatsapp(...)`/`waInstance.mediaMessage(...)` calls (`chatwoot.service.ts:1663,1688`) — those already need a `chatwootLinkContext` parameter added to `audioWhatsapp`/`mediaMessage` on `BaileysStartupService` too, same pattern as `contactMessage`. Then at the call site itself:
```typescript
const chatwootLinkContext: ChatwootMessage = {
  messageId: body.id,
  inboxId: body.inbox?.id,
  conversationId: body.conversation?.id,
  contactInboxSourceId: body.conversation?.contact_inbox?.source_id,
};

const messageSent =
  attachment.file_type === 'contact'
    ? await waInstance?.contactMessage({ ... } as SendContactDto, true, chatwootLinkContext)
    : await this.sendAttachment(waInstance, chatId, attachment.data_url, formatText, options, chatwootLinkContext);

if (!messageSent && body.conversation?.id) {
  this.onSendMessageError(instance, body.conversation?.id);
}
// delete the updateChatwootMessageId(...) call that followed (chatwoot.service.ts:1923-1934) — executeSendMessage does it now
```

**4d. Thread `chatwootLinkContext` through the text block** (`chatwoot.service.ts:1937-1968`), same pattern:
```typescript
const chatwootLinkContext: ChatwootMessage = {
  messageId: body.id,
  inboxId: body.inbox?.id,
  conversationId: body.conversation?.id,
  contactInboxSourceId: body.conversation?.contact_inbox?.source_id,
};

let messageSent: any;
try {
  messageSent = await waInstance?.textMessage(data, true, chatwootLinkContext);
  if (!messageSent) throw new Error('Message not sent');
  // delete the Long.isLong(...) timestamp fixup and updateChatwootMessageId(...) call that followed
  // (chatwoot.service.ts:1953-1968) — executeSendMessage does both now
} catch (error) {
  if (!messageSent && body.conversation?.id) this.onSendMessageError(instance, body.conversation?.id, error);
  throw error;
}
```
Add the matching optional param to `textMessage(data: SendTextDto, isIntegration = false, chatwootLinkContext?: ChatwootMessage)` (`whatsapp.baileys.service.ts:2709` — check exact current line after Task 6/7's edits shift things).

**4e. Update `sendMessageWithTyping`'s signature** (Step 3 above) to accept `chatwootLinkContext` as its 5th parameter — already reflected there. Every method touched in 4c/4d just forwards it down to `sendMessageWithTyping`, which forwards it into the job payload (queued) or `executeSendMessage` (inline).

This was the highest-uncertainty part of the plan when first drafted; it's now grounded against the live file (post the Task 6/7/9 baseline). Still worth an extra compile-and-grep pass after implementing, since `mediaMessage`/`audioWhatsapp`/`textMessage` each have their own existing parameter lists that the new optional param must slot into without breaking other callers (`base-chatbot.service.ts`, `typebot.service.ts`, `SendMessageController`) that call them with fewer arguments.

**Step 5:** `npx tsc --noEmit -p tsconfig.json` — expect errors pointing at exactly the callers that need the DTO/param threading from Step 4; fix each.

**Step 6: Manual verification** — see Task 12.

Commit: `feat(baileys): split sendMessageWithTyping into queue dispatcher + executeSendMessage`

---

## Part E — Wiring, docs, verification

### Task 10: Boot wiring

**Files:** Modify `src/api/server.module.ts`

Add after `chatwootController` is created:
```typescript
if (isBullMQEnabled()) {
  startChatwootForwardWorker(chatwootService);
  startWaInboundWorker(waMonitor);
  startWaOutboundWorker(waMonitor);
  logger.info('BullMQ:MessagePipeline - ON (wa-inbound, chatwoot-forward, wa-outbound)');
} else {
  logger.info('BullMQ:MessagePipeline - OFF (BULLMQ_ENABLED=false or CACHE_REDIS_ENABLED=false), using synchronous fallback');
}
```
Imports:
```typescript
import { isBullMQEnabled } from './queues/bullmq-connection';
import { startChatwootForwardWorker } from './integrations/chatbot/chatwoot/queues/chatwoot-forward.worker';
import { startWaInboundWorker } from './integrations/channel/whatsapp/queues/wa-inbound.worker';
import { startWaOutboundWorker } from './integrations/channel/whatsapp/queues/wa-outbound.worker';
```

Verify boot: `npm run dev:server`, look for the `BullMQ:MessagePipeline - ON` log line with `BULLMQ_ENABLED=true`.

Commit: `feat: wire up BullMQ message pipeline workers at boot`

---

### Task 11: Update CLAUDE.md

Add under "Message Queue Architecture":
```markdown
### Internal BullMQ Message Pipeline (opt-in via BULLMQ_ENABLED)
- `wa-inbound`: Baileys `messages.upsert`/`messages.update` processing, decoupled from the per-instance `eventProcessingQueue`.
- `chatwoot-forward`: generic sink for all instance→Chatwoot events (new message, read receipt, delete, send confirmation).
- `wa-outbound`: all outbound sends (HTTP API, chatbot integrations, Chatwoot agent replies) — full async, response is a queued job id, not the sent message. Real send confirmation arrives via the `Events.SEND_MESSAGE` webhook, as before.
- All three fall back to today's synchronous/fire-and-forget behavior when `BULLMQ_ENABLED=false` (default) or Redis is unavailable.
- Code: `src/queues/` (shared) and `*/queues/` under each relevant module.
```

Commit: `docs: document BullMQ message pipeline`

---

### Task 12: End-to-end manual verification

No automated test harness exists for this project beyond the pure-function tests added in Task 4 (see CLAUDE.md — manual testing is the primary approach here). With `BULLMQ_ENABLED=true`, `CACHE_REDIS_ENABLED=true`, a test instance connected, and Chatwoot configured on it:

1. **Inbound fix (the original bug):** send 3 WhatsApp messages back-to-back to the test instance. Confirm all 3 are saved to the DB and appear in Chatwoot within a few seconds, in order. Then block the Chatwoot host (firewall/hosts file) and send 3 more — confirm they still save to DB immediately and don't delay each other; confirm they eventually land in Chatwoot once connectivity is restored (worker retries).
2. **Read receipt → Chatwoot:** from the test WhatsApp account's side, read a message the instance sent. Confirm the corresponding Chatwoot conversation reflects the read status (same code path as `messages.upsert`, via `messages.read` event) — this is the case you specifically flagged.
3. **Outbound full-async:** `POST /message/sendText` — confirm the HTTP response is now `{ jobId, status: 'queued' }`, not the sent message. Confirm the `Events.SEND_MESSAGE` webhook fires shortly after with the real message. Confirm the message actually arrives on the recipient's phone.
4. **Outbound ordering:** trigger a Typebot/EvolutionBot flow that sends 3 messages in a row. Confirm they arrive at the recipient in the same order they were triggered (this is what the per-instance lock in Task 8 protects).
5. **Chatwoot agent reply linking:** reply to a conversation from the Chatwoot UI as an agent. Confirm the message is sent to WhatsApp and that the Chatwoot message record gets linked to the real WhatsApp message id afterward (check `updateChatwootMessageId` actually ran — this is the constraint #3 fix, verify it didn't silently stop working).
6. **Fallback path:** set `BULLMQ_ENABLED=false`, restart, repeat steps 1 and 3 — confirm behavior matches pre-this-plan behavior exactly (synchronous chatwoot forward, synchronous send response).

Commit any fixes found during this pass as their own small commits, not squashed into earlier task commits.

---

## Known limitations (documented, not solved here)

- **Not exactly-once.** `wa-outbound` retries can duplicate a real WhatsApp send if the send itself succeeded but a later step (DB write) failed. Bounded by low `ATTEMPTS` default; a proper fix (idempotency key checked before resending) is future work if duplicates show up in practice.
- **`messaging-history.set` and lifecycle events (QR, connection open/close, contacts-update) stay synchronous**, including the `await this.chatwootService.eventWhatsapp(Events.CONTACTS_UPDATE, ...)` call found at `whatsapp.baileys.service.ts:1527` during history sync. Same blocking pattern, lower priority (backfill, not real-time), same `chatwoot-forward` queue could absorb it later with no redesign.
- **Per-instance lock adds latency** under high concurrency for a single very active instance (jobs queue up behind the lock instead of running in parallel) — this is the deliberate trade-off for correctness (message order) over raw throughput; if one instance's volume ever needs true parallel processing, that requires a design that tolerates reordering, which chat/unread-count logic currently does not.
- **`chatwoot.service.ts` call-site threading (Task 9, Step 4)** — grounded against live code during review (2 sites, not 4; exact field names confirmed), but still the part of the plan touching the most call sites across two files (`contactMessage`/`sendAttachment`/`textMessage`/`mediaMessage`/`audioWhatsapp` all need the new optional param) — verify no other caller of those 5 methods breaks after the signature changes.
