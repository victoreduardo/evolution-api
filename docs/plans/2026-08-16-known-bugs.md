# Known Bugs — found during BullMQ pipeline manual verification

Bugs found while running [2026-08-16-bullmq-pipeline-test-plan.md](2026-08-16-bullmq-pipeline-test-plan.md) that are **out of scope** for the BullMQ pipeline plan itself (pre-existing, unrelated code paths) — logged here to address separately, not blocking the pipeline work.

---

## 1. Duplicate "Connection successfully established!" messages to Chatwoot

**Status:** Confirmed real bug, not yet fixed.

**Symptom:** The Chatwoot conversation for a connected instance received the `🚀 Connection successfully established!` message **7 times** in one test session, including a burst of **5 messages in 50 seconds** (12:04:40 → 12:05:30 UTC) — far too tight to correspond to 5 real reconnects.

**Root cause:** `whatsapp.baileys.service.ts:511-516` — inside `connectionUpdate()`, on `connection === 'open'`, calls `chatwootService.eventWhatsapp(Events.CONNECTION_UPDATE, ...)` directly and synchronously (not routed through the new `chatwoot-forward` BullMQ queue — `CONNECTION_UPDATE` was explicitly left out of scope of the BullMQ migration as a low-volume lifecycle event, see [2026-08-15-bullmq-message-pipeline.md](2026-08-15-bullmq-message-pipeline.md)'s Known Limitations).

The receiving dedup logic in `chatwoot.service.ts:3178-3202` has two branches:
- If `waInstance.qrCode.count > 0`: sends **immediately, no throttle**, then resets `count = 0` and `lastConnectionNotification` — but only **after** the `await` completes.
- Otherwise: throttles to one notification per 30s via `waInstance.lastConnectionNotification`.

Both guards live only on the in-memory `waInstance` object, never persisted, and the check-then-act gap around the immediate-send branch means a second `open` event can re-enter before the first call's reset lands — a classic non-atomic check-then-act race, the same class of bug the `withInstanceLock` fix (`src/queues/instance-lock.ts`) addressed for the new pipeline, just on an older code path that wasn't touched by this plan.

**Fix sketch (not applied yet):**
- Make the guard atomic — e.g. an actual lock (same `SET...NX` pattern as `instance-lock.ts`) around the whole check-send-reset sequence, or move the reset to happen **before** the send instead of after.
- Consider routing `CONNECTION_UPDATE` through `dispatchChatwootEvent`/`chatwoot-forward` for consistency and free retry/timeout handling, now that the queue infrastructure exists — this was deliberately deferred in the original plan but this bug is a concrete case for revisiting that.

**Found by:** background investigation agent, cross-referencing Chatwoot API message history (`GET /api/v1/accounts/26/conversations/21/messages`) against Postgres `Instance.updatedAt` and dev server logs during manual pipeline verification.
