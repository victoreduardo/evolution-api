# BullMQ Message Pipeline — Manual Test Plan

Companion to [2026-08-15-bullmq-message-pipeline.md](2026-08-15-bullmq-message-pipeline.md). Covers every scenario needed to validate the implementation before merging, run against a real WhatsApp connection and the local Chatwoot instance.

## Environment (already set up)

- API: `npm run dev:server` on host, port 8080, `BULLMQ_ENABLED=true`.
- Redis: standalone container `evolution_redis_verify`, `localhost:56380`.
- Postgres: standalone container `evolution_postgres_verify`, `localhost:55432`, migrated.
- Chatwoot: local instance at `http://localhost:3010`, `chat-rails-1` container. **`chat-sidekiq-1` is broken** (missing gems, pre-existing/unrelated to this work) — Chatwoot's own outbound webhook delivery (agent reply → Evolution) may be affected since Sidekiq usually dispatches those jobs. Flag any agent-reply test that silently doesn't fire as a Sidekiq issue, not a BullMQ pipeline bug, before spending time debugging it here.
- Test instance: `bullmq-verify`, Chatwoot account 26, inbox 27 (`Channel::Api`), auto-created and confirmed working (log: `Inbox created - inboxId: 27`, `Contact created`, `Init message sent`, zero errors).
- Auth: `apikey: 429683C4C977415CAAFCCE10F7D57E11` header on all Evolution API calls.

## Already verified (sync actions, pre-WhatsApp-connect)

- [x] `POST /instance/create` — instance created, QR code returned (base64 + pairing code).
- [x] `GET /instance/fetchInstances` — instance listed correctly.
- [x] `GET /instance/connectionState/:name` — reports `connecting`.
- [x] Boot log shows `BullMQ:MessagePipeline - ON (wa-inbound, chatwoot-forward, wa-outbound)` and `BullMQ redis connection ready`.
- [x] Chatwoot auto-provision on instance creation: inbox + contact + init message, zero errors in log.

## How to verify each test

- **Evolution log**: `tail -f /tmp/evolution-dev-server.log` (or wherever the dev server's stdout is redirected) — grep for `error`, the relevant `Logger` tag (`ChatwootForwardWorker`, `WaInboundWorker`, `WaOutboundWorker`), or the job id.
- **DB**: `psql postgresql://user:pass@localhost:55432/evolution` — check `"Message"` rows for `chatwootMessageId`/`chatwootConversationId`/`chatwootInboxId`.
- **Chatwoot**: UI at `http://localhost:3010` (login as `john@acme.inc`, account 26 — ask the user for the password, not stored here) or API with the access token used to configure the integration.
- **Redis job state**: `redis-cli -p 56380 -n 6 keys 'bull:*'` to see queued/active/failed jobs per queue (`bull:wa-inbound:*`, `bull:chatwoot-forward:*`, `bull:wa-outbound:*`).

---

## 1. Connection lifecycle

| # | Scenario | Steps | Expected | Status |
|---|---|---|---|---|
| 1.1 | QR scan → connection opens | Scan the QR from `bullmq-verify`'s `qrcode.base64` with a real WhatsApp | `connectionState` moves `connecting` → `open`; log shows `CONNECTED TO WHATSAPP`; Chatwoot conversation for the init message stays intact | ⬜ |
| 1.2 | Reconnect without new QR | After 1.1, kill and restart the dev server process, or force a socket drop | Instance reconnects using saved session — no new QR required, `connectionState` returns to `open` | ⬜ |
| 1.3 | Instance delete mid-flight | Send a burst of messages, then `DELETE /instance/delete/bullmq-verify` immediately after | No `P2003` FK-violation errors in log (the exact bug fixed by commit `fc46e290`); `wa-inbound` jobs for the deleted instance log "instance not found, dropping" instead of crashing | ⬜ |
| 1.4 | Second instance, isolated Chatwoot inbox | `POST /instance/create` with a second `instanceName` (e.g. `bullmq-verify-2`), same Chatwoot account, `autoCreate: true` | A **different** inbox id is created; messages from instance 1 never appear in instance 2's inbox and vice versa | ⬜ |
| 1.5 | N instances created concurrently | Fire 3-5 `POST /instance/create` calls in parallel (`&` in bash or `xargs -P`) | All succeed, each gets its own inbox, no inbox/contact cross-assignment, no deadlock/error in log | ⬜ |

## 2. Inbound: message → Chatwoot (`wa-inbound` → `chatwoot-forward`)

| # | Scenario | Steps | Expected | Status |
|---|---|---|---|---|
| 2.1 | Plain text received | From the connected phone, send "oi" to the instance's number | Appears in Chatwoot conversation within a few seconds; `Message` row has `chatwootMessageId`/`chatwootConversationId` populated | ⬜ |
| 2.2 | Image received | Send a photo | Appears in Chatwoot with the image attached (not just a text placeholder) | ⬜ |
| 2.3 | Audio/voice note received | Send a voice note | Appears in Chatwoot as a playable audio attachment | ⬜ |
| 2.4 | Document received | Send a PDF/doc | Appears in Chatwoot as a downloadable file | ⬜ |
| 2.5 | Burst of 5 messages back-to-back | Send 5 texts within ~2 seconds | All 5 arrive in Chatwoot **in order**, none dropped (validates `wa-inbound` per-instance lock ordering) | ⬜ |
| 2.6 | Group message | Send a message to/from a WhatsApp group the instance is in | Chatwoot group conversation created/updated correctly, sender identified | ⬜ |
| 2.7 | Read receipt reflected | Read (on the recipient's end) a message the instance sent | The `messages.read` event reaches Chatwoot via `chatwoot-forward` (`dispatchChatwootEvent('messages.read', ...)` — check log for the job, not a UI-visible change in this Chatwoot version necessarily) | ⬜ |
| 2.8 | Message edit reflected | Edit a message you sent from WhatsApp | `messages.edit` event dispatched, log shows no error | ⬜ |
| 2.9 | Message delete reflected | Delete a message you sent from WhatsApp (for everyone) | `Events.MESSAGES_DELETE` dispatched via `dispatchChatwootEvent`, `Message.status` becomes `DELETED` | ⬜ |
| 2.10 | Chatwoot unreachable during receive | Stop `chat-rails-1` (`docker stop chat-rails-1`), send a message, wait, then `docker start chat-rails-1` | Message still saves to DB immediately (not blocked); `chatwoot-forward` job retries with backoff and eventually delivers once Chatwoot is back — check `bull:chatwoot-forward:failed`/`active` in redis-cli meanwhile | ⬜ |
| 2.11 | Concurrent instances, parallel processing | With 2 connected instances (from 1.4/1.5), send messages to both at the same time | Both process without one blocking the other — this is the actual regression test for the original reported bug | ⬜ |

## 3. Outbound: send → WhatsApp (`wa-outbound` → `chatwoot-forward`)

| # | Scenario | Steps | Expected | Status |
|---|---|---|---|---|
| 3.1 | Plain text send via API | `POST /message/sendText` with `{number, text}` | HTTP response is `{jobId, status: "queued"}`, **not** the sent message; message physically arrives on the recipient's phone within a few seconds; `Events.SEND_MESSAGE` webhook fires with the real message shortly after | ⬜ |
| 3.2 | Media send via API | `POST /message/sendMedia` | Same as 3.1, media arrives correctly | ⬜ |
| 3.3 | Sequential sends stay ordered | Fire 3 `sendText` calls back-to-back to the same number | All 3 arrive on the recipient's phone in the order sent (validates `wa-outbound` per-instance lock) | ⬜ |
| 3.4 | Chatwoot agent reply relayed | In Chatwoot UI (or via API `POST /api/v1/accounts/26/conversations/:id/messages`), send a message as the agent on the `bullmq-verify` inbox's conversation | Message arrives on the recipient's WhatsApp; **no self-echo duplicate** appears back in the Chatwoot conversation (regression test for commit `3a33c7d1`); `Message` row gets `chatwootMessageId` linked (constraint #5/#6 fix) — verify with the DB query below | ⬜ |
| 3.5 | Chatwoot agent sends a contact card | Same as 3.4 but a contact-card attachment | No duplicate echo (this was the exact bug `3a33c7d1` fixed — must not regress) | ⬜ |
| 3.6 | Retry does not duplicate-send | Hardest to trigger organically — see "Forcing a mid-flight failure" below. Confirm only **one** message reaches the recipient even when a later step (DB persist) is forced to fail after the real send succeeds | ⬜ |
| 3.7 | Send to nonexistent/invalid number | `sendText` to a clearly invalid number | Job fails cleanly (BadRequestException surfaces in job failure log), no crash, no retry storm | ⬜ |
| 3.8 | Bot-integration send (Typebot/EvolutionBot if configured) | Trigger a bot flow that sends 2-3 messages | Messages arrive in order, `isIntegration=true` path taken (no chatwoot self-echo of the bot's own messages via the wrong path) | ⬜ |

### Verifying 3.4's chatwootMessageId link (DB query)

```sql
SELECT "key"->>'id' AS wa_message_id, "chatwootMessageId", "chatwootConversationId"
FROM "Message"
WHERE "instanceId" = (SELECT id FROM "Instance" WHERE name = 'bullmq-verify')
ORDER BY "createdAt" DESC LIMIT 5;
```
`chatwootMessageId` must be non-null for the agent-sent message.

### Forcing a mid-flight failure (3.6)

Temporarily point Postgres at an unreachable host (edit `.env`'s `DATABASE_CONNECTION_URI` to a bad port, restart the dev server) **only for this one test**, trigger a send, confirm the WhatsApp message still arrives (send itself doesn't depend on DB), then confirm in the log that a retry occurred (`wa-outbound job ... failed`) followed by success once DB access is restored — and confirm via WhatsApp that the recipient got exactly one copy of the message, not two. Revert `.env` immediately after.

## 4. Fallback mode (`BULLMQ_ENABLED=false`)

| # | Scenario | Steps | Expected | Status |
|---|---|---|---|---|
| 4.1 | Boot with BullMQ disabled | Set `BULLMQ_ENABLED=false` in `.env`, restart | Log shows `BullMQ:MessagePipeline - OFF ...`; no BullMQ Redis connection attempted | ⬜ |
| 4.2 | Inbound still works synchronously | Repeat 2.1 with BullMQ disabled | Message still reaches Chatwoot (via the direct/inline path), same end result as 2.1, just processed inline instead of queued | ⬜ |
| 4.3 | Outbound returns real message again | Repeat 3.1 with BullMQ disabled | HTTP response is the **real sent message** (not `{jobId, status:'queued'}`) — confirms the fallback dispatcher branch | ⬜ |
| 4.4 | Re-enable and confirm queue resumes | Set `BULLMQ_ENABLED=true`, restart, repeat 2.1/3.1 | Back to queued behavior, no leftover state issues from the mode switch | ⬜ |

## 5. Resilience / edge cases

| # | Scenario | Steps | Expected | Status |
|---|---|---|---|---|
| 5.1 | Redis unavailable at boot | Stop `evolution_redis_verify`, start the dev server | `isBullMQEnabled()` returns false (checks `CACHE.REDIS.ENABLED` too), falls back cleanly, no crash loop | ⬜ |
| 5.2 | Redis dies mid-run | Start normally (BullMQ on), then `docker stop evolution_redis_verify` while messages are flowing | In-flight jobs fail/retry against the dead connection; app doesn't crash; once Redis restarts, workers reconnect (`BullMQConnection` log) and resume | ⬜ |
| 5.3 | Very large media | Send a large video/document (near WhatsApp's size limits) | Handled without timeout inside `CHATWOOT_FORWARD_TIMEOUT_MS`/`WA_OUTBOUND_TIMEOUT_MS` for reasonably-sized files; if it does time out, confirm it fails and retries gracefully rather than hanging the worker permanently | ⬜ |
| 5.4 | Special characters / emoji / long text | Send a message with emoji, RTL text, and ~4000 chars | Arrives intact in both directions, no encoding corruption | ⬜ |
| 5.5 | Quoted/reply message | Reply to a specific WhatsApp message, both directions (WA→Chatwoot and Chatwoot→WA) | Quote/reply threading preserved in Chatwoot (`in_reply_to`) and in WhatsApp | ⬜ |
| 5.6 | Job retry exhaustion | Force `chatwoot-forward` to fail all `CHATWOOT_FORWARD_ATTEMPTS` (e.g. stop Chatwoot for longer than the total backoff window) | Job ends up in Redis's failed set (`bull:chatwoot-forward:failed`), clearly logged, does **not** silently vanish or crash the worker | ⬜ |
| 5.7 | Concurrent same-conversation inbound + outbound | Send a message from WhatsApp while simultaneously sending one via API to the same number | Both process correctly without corrupting `createConversation`'s lock/cache state; no duplicate conversation created | ⬜ |

---

## After running

Update each ⬜ to ✅ (or ❌ with a short note + log excerpt) as you go. Any ❌ should get its own investigation before this branch is considered ready — don't batch-fix at the end; note the failure and keep testing so gathered results reflect one consistent code state.
