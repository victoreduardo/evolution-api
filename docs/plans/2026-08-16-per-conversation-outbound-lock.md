# Per-Conversation wa-outbound Lock — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use forge:executing-plans to implement this plan task-by-task.

**Goal:** Change `wa-outbound`'s serialization key from per-instance to per-conversation (`instanceName:jid`), so sends to different recipients from the same instance run in parallel instead of queueing behind each other, while sends to the *same* recipient stay strictly ordered.

**Architecture:** `withInstanceLock` (`src/queues/instance-lock.ts`) is already generic — it takes an arbitrary key, not something instance-specific. The only change needed is *what key* `wa-outbound.worker.ts` passes it: today `instanceName` alone, this plan changes it to `${instanceName}:${createJid(number)}`. `createJid` (`src/utils/createJid.ts`) is a pure, synchronous JID normalizer already used throughout the codebase — no new async work, no new cache dependency, deterministic across formatting variants of the "same" number (with/without `+`, spaces, country-code quirks it already handles).

**Tech stack:** No new dependencies. Touches `src/api/integrations/channel/whatsapp/queues/wa-outbound.worker.ts` only (plus a doc update).

---

## Why this is safe — evidence, not assumption

Baileys itself is built for exactly this kind of parallelism: `node_modules/baileys/lib/Socket/messages-send.js:27` — `const encryptionMutex = makeKeyedMutex();`, keyed by `jid` (`messages-send.js:372-373`, `mutexKey = jid`). `makeKeyedMutex()` (`node_modules/baileys/lib/Utils/make-mutex.js`) creates one independent mutex chain per key — different JIDs run fully concurrently, the same JID serializes. Baileys' own Signal Protocol session safety already only needs per-recipient ordering, not per-socket/per-instance ordering. This plan's lock change doesn't ask Baileys to do anything it wasn't already designed to handle safely underneath.

## Why this matters — current bottleneck

Today, `WA_OUTBOUND_CONCURRENCY` (default 5) is close to meaningless for a single busy instance: the per-instance lock means only one `wa-outbound` job can actually be *inside* `executeSendMessage` at a time for that instance, no matter how many workers are free. The concurrency setting only helps when multiple *different* instances are sending simultaneously. After this change, one instance with 5 active conversations can genuinely use all 5 concurrency slots at once — the setting starts meaning what its name says for the single-instance case too.

## Non-goals (explicitly out of scope for this plan)

- **`wa-inbound` is not touched here.** It uses the same `withInstanceLock` helper for a different reason (chat/unread-count state assumptions during `messages.upsert`/`messages.update` processing) that wasn't re-examined as part of this request. It's a plausible future candidate for the same per-conversation narrowing (unread counts are themselves scoped per-`remoteJid`, not instance-wide), but that's a separate decision — don't fold it into this change.
- **No change to `WA_OUTBOUND_CONCURRENCY`'s default value.** This plan changes what contends for a slot, not how many slots exist.
- **No change to the idempotency-key mechanism** (still `job.id`, unaffected by lock-key granularity).

## Risk to flag, not solve here

Sending to many different recipients from one instance in true parallel, rather than one-at-a-time, increases the instance's outbound message rate over any given short window. WhatsApp's own anti-spam/rate-limit heuristics are opaque and account-specific — this is a behavior change worth watching in production (via existing `wa-outbound` failure logs) after rollout, not something this plan can fully de-risk in advance. If it turns out to matter, `WA_OUTBOUND_CONCURRENCY` is already the existing knob to turn down.

---

### Task 1: Change the lock key

**Files:** Modify `src/api/integrations/channel/whatsapp/queues/wa-outbound.worker.ts`

**Step 1: Add the import**

```typescript
import { createJid } from '@utils/createJid';
```

**Step 2: Compute the composite key and use it**

Current (`wa-outbound.worker.ts`, inside the job processor):
```typescript
      await withInstanceLock(getBullMQConnection(), 'wa-outbound-lock', instanceName, () =>
        withTimeout(
          instance.executeSendMessage(
            number,
            message,
            options,
            isIntegration,
            chatwootLinkContext,
            true,
            job.id,
          ),
          TIMEOUT_MS,
        ),
      );
```

Change to:
```typescript
      const conversationKey = `${instanceName}:${createJid(number)}`;

      await withInstanceLock(getBullMQConnection(), 'wa-outbound-lock', conversationKey, () =>
        withTimeout(
          instance.executeSendMessage(
            number,
            message,
            options,
            isIntegration,
            chatwootLinkContext,
            true,
            job.id,
          ),
          TIMEOUT_MS,
        ),
      );
```

`withInstanceLock`'s third parameter is generically named `instanceName` in its own signature (`src/queues/instance-lock.ts`) since it was written for the instance-only case — it's just a lock key component, so passing a composite string works without touching that file. (Optional cleanup, not required: rename that parameter to `lockKey` in `instance-lock.ts` for clarity now that it's not always literally an instance name — cosmetic, do it only if it doesn't turn into unrelated churn across `wa-inbound.worker.ts`'s call site too.)

**Step 3: Verify**

```bash
npx tsc --noEmit -p tsconfig.json
npx eslint --fix src/api/integrations/channel/whatsapp/queues/wa-outbound.worker.ts
npx eslint src/api/integrations/channel/whatsapp/queues/wa-outbound.worker.ts
```
Expect clean output from all three.

**Step 4: Existing unit test already covers the mechanism**

`tests/instance-lock.test.ts` tests `withInstanceLock` generically (same-key serializes, different-key parallelizes, lock releases on error) — it doesn't know or care whether the key is an instance name or a composite string, so it already validates the property this change relies on. No new unit test needed for `withInstanceLock` itself.

**Step 5: Commit**

```bash
git add src/api/integrations/channel/whatsapp/queues/wa-outbound.worker.ts
git commit -m "$(cat <<'EOF'
feat(baileys): scope wa-outbound lock to conversation, not instance

withInstanceLock's key changes from instanceName alone to
instanceName:createJid(number), so sends to different recipients
from the same instance run in parallel (up to WA_OUTBOUND_CONCURRENCY)
instead of queueing behind each other one-at-a-time regardless of
recipient. Sends to the same recipient still serialize in order.

Safe per Baileys' own design: messages-send.js's encryptionMutex is
a keyed mutex on jid (makeKeyedMutex(), Socket/messages-send.js:27,
372-373) - different JIDs already encrypt/send concurrently at the
Baileys layer; this lock was more conservative than Baileys itself
requires.

wa-inbound keeps its per-instance lock - different tradeoff (chat/
unread-count state), not re-examined here.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Manual verification (live, real WhatsApp)

Add to [2026-08-16-bullmq-pipeline-test-plan.md](2026-08-16-bullmq-pipeline-test-plan.md) as a new row under section 3, or run standalone:

1. **Parallelism across conversations:** with the connected test instance, fire `sendText` to two *different* numbers back-to-back (e.g. number A then number B, both via curl, no delay between requests). Before this change, B would wait for A to fully finish (typing delay + send + persist) before starting. After this change, confirm via log timestamps (`Sending message to <jid>` lines) that B's processing starts before A's finishes — genuine overlap, not just fast sequential completion.
2. **Ordering within one conversation still holds:** repeat Test 3.3 from the main test plan (3 sequential sends to the *same* number) — must still arrive in order. This is the property that must NOT regress.
3. **No cross-contamination:** confirm number A's and number B's messages each land in their own correct Chatwoot conversation, not mixed up — sanity check that the parallel execution path doesn't leak state between concurrent job runs (it shouldn't - `executeSendMessage` doesn't share mutable state across calls beyond what BullMQ/the lock already isolates - but worth eyeballing once live rather than assuming).

Record results (✅/❌ + evidence) inline in this section or in the main test plan doc, whichever is currently being used to track the live verification pass.
