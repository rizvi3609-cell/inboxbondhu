# InboxBondhu — On-Call Runbook

Phase 9 deliverable. One page per failure, symptom-first, commands you can paste.
Alert names below match §15.5 of `prompt.md` and the pino log fields the code emits.

**Golden rule (§14):** losing a customer message is unacceptable; being temporarily
unable to answer it is survivable. Everything on this page is ordered by that rule.

---

## 0. First 60 seconds — whatever the page says

```bash
curl -s localhost:4000/healthz | jq          # 200 always; degraded:true ⇒ Mongo is down
curl -s localhost:4000/readyz  | jq          # 503 ⇒ LB should already be draining
redis-cli ping                                # PONG or Redis is the story
redis-cli llen buffer:webhooks               # >0 ⇒ webhook events are buffering (Mongo down)
ls -la /var/lib/inboxbondhu/journal/         # ndjson files ⇒ D22 last-resort journal in use
pm2 status                                    # api / worker process state
```

Severity ladder:
- **SEV1** — `tenant.scope_violation` (ANY), `order.oversell_detected` (ANY), journal shedding (`buffer:webhooks` > 100 MB), data loss suspected.
- **SEV2** — degraded mode > 5 min, DLQ depth > 10 for 15 min, AI paused platform-wide.
- **SEV3** — single-workspace issues, canary failure, elevated handover rate.

---

## 1. Mongo is down (`degraded_mode.active`, readyz 503)

**Designed behaviour (§14.1)** — already happening without you:
- `POST /webhooks/meta` still ACKs 200 (< 500 ms), events buffer to Redis `buffer:webhooks`.
- Every other route returns `503 DEGRADED_MODE` instantly (readyState probe, no stall).
- `/healthz` stays 200 with `degraded: true`; `/readyz` 503 so the LB drains.

**Your job:** bring Mongo back; the system heals itself.
```bash
# managed DB: check DO status page + connection count first
mongosh "$MONGODB_URI" --eval 'db.runCommand({ping:1})'
redis-cli llen buffer:webhooks        # watch it grow — capacity is ~24 h of traffic
```
**Recovery is automatic:** `webhookBufferDrainer` (every 30 s) replays the Redis
buffer, then the D22 journal, in order, deduped by I48. Verify:
```bash
redis-cli llen buffer:webhooks        # → 0 within a minute of Mongo returning
# worker log: "webhookBufferDrainer" lines with drained>0
```
**Do NOT** restart the api/worker while the buffer drains — you gain nothing and lose in-flight jobs.

---

## 2. Redis is down (P-02)

**Designed behaviour:** Mongo is authoritative for everything durable.
- Rate limits **fail open** (logged loudly) — auth still works.
- Socket.IO degrades to single-instance; dashboards fall back to polling/refetch.
- Queues stop; the webhook path falls back to the **D22 disk journal** and still ACKs 200.

```bash
redis-cli ping                        # confirm
systemctl restart redis               # or DO managed → console
# after recovery, REQUIRED check (INV-11):
redis-cli config get maxmemory-policy # MUST be noeviction — boot asserts it, you assert it too
ls /var/lib/inboxbondhu/journal/      # journal files drain automatically within 30 s of both stores returning
```
BullMQ jobs enqueued during the outage don't exist — but the source rows do
(webhookEvents `pending`, outboxEvents `pending`): the sweepers re-drive them.

---

## 3. `ALERT order.oversell_detected` (SEV1 — any occurrence)

`reconcileStock` (nightly) found `reserved` drift or `reserved > stock`.
```bash
# The log line carries {productId, variantSku, expected, actual}.
# 1. Freeze the variant:
#    PATCH /products/:id  {variants[i].isActive: false}  (admin token)
# 2. Compare stockReservations 'held' rows against variants.$.reserved:
mongosh "$MONGODB_URI" --eval '
  db.stockReservations.aggregate([{$match:{status:"held"}},
    {$group:{_id:{p:"$productId",s:"$variantSku"},n:{$sum:"$qty"}}}])'
# 3. The RESERVATIONS are the truth (they carry orderIds). Set reserved to the sum.
# 4. Find how it drifted: audit trail for the product + order, look for a
#    code path that touched variants outside T1. That is a bug — file it SEV1.
```

## 4. `tenant.scope_violation` (SEV1 — any occurrence)

A query ran without a workspaceId filter. The tenancy plugin THREW (request
failed safely) — the alert is about the code path, not data exposure.
The log carries `{collection, operation, requestId}`. Find the requestId in
api logs → route → fix the query. Nothing to remediate at runtime; every
violating request got a 500 instead of data.

---

## 5. DLQ depth > 10 for 15 min

```bash
# What died? GET /w/:id/jobs/failed (agent) shows tenant-filtered failures.
# Cross-tenant view (you, on the box):
redis-cli keys 'bull:*:failed' | head
```
- **outbound-message failures**: check `failureCode` — `WINDOW_EXPIRED` is
  designed (P-01, never retried); `PERMANENT_4XX` means the page token is bad
  → owner must reconnect the channel (tokenExpiryChecker should have warned).
- **email ladder exhausted** (30 s/2 m/10 m → dead): Resend outage or bad
  address. Retry from Failed Jobs after the provider recovers.
- **webhook-ingest**: check the raw event in `webhookEvents.lastError`.
  Retry requires admin (`POST /jobs/:id/retry`).

## 6. AI paused / handover spike (`ai.handover_rate`, `ai.cost_minor`)

- **One workspace**: quota (100 % soft block — designed; humans keep working;
  owner can upgrade) or the ৳200 daily cost cap. `GET /w/:id/usage`.
- **Platform-wide**: platform cost cap or LLM provider down. The pipeline
  hands over on failure — customers see a human-pending state, never silence.
  Check provider status; nothing to restart. Replies resume on the next
  inbound message once the provider recovers.
- **`ai.grounding_blocked` sustained**: the model is hallucinating more than
  usual (provider-side drift) or the catalogue went stale. Check `evalCanary`
  results (04:00 daily, `ALERT ai.canary_failed`) — a canary failure plus a
  grounding spike = pin/rollback `PROMPT_VERSION`.

## 7. Socket storm after a deploy (P-08)

Symptom: connection spikes, `realtime` CPU. Designed responses already in
place: client backoff + jitter, per-workspace connection caps, `updatedSince`
reconciliation (one cheap query per reconnect, no full refetch).
If it persists: you deployed twice in quick succession; wait out the backoff
window — do NOT restart the api again (that restarts the storm).

## 8. Webhook p95 > 400 ms (`webhook.response_time`)

The 500 ms budget (INV-06) is being eaten. The path is: HMAC → dedupe →
insert → enqueue → 200. Check in order:
```bash
redis-cli --latency          # Redis slow ⇒ SETNX dedupe is the bottleneck
mongosh --eval 'db.serverStatus().connections'   # Mongo backpressure
```
If Mongo is the cause, remember the path deliberately probes readyState and
skips straight to the buffer when down — *slow* Mongo is worse than *down*
Mongo here. If sustained: fail Mongo over / restart it, let the buffer absorb.

## 9. Restore / DR

Backups: DO managed daily snapshot + PITR (7 days). To prove a backup (or
restore for real):
```bash
pnpm tsx tools/restoreDrill.ts "$MONGODB_URI" "mongodb://scratch-host/inboxbondhu_restore"
```
The drill dumps (canonical EJSON), restores to a scratch DB, and verifies
counts + content hashes + order-money invariants. Run it monthly; it exits
non-zero when a backup is not restorable — treat that as SEV2.

## 10. Load test (before every capacity-affecting change)

```bash
pnpm tsx tools/loadTest.ts http://127.0.0.1:4000 "$META_APP_SECRET" 30
```
Drives 2× the CON-05 peak (bursty). Gates: webhook p95 < 500 ms, zero
non-200s, /healthz p95 < 200 ms. Non-zero exit = do not ship the change.

---

## Daily/weekly checks (not pages)

| When | What |
|---|---|
| 03:00 Dhaka | `retentionPurger` ran — worker log `retentionPurger report`; batches > 0 is normal, errors are not |
| 04:00 Dhaka | `evalCanary` — any `ALERT ai.canary_failed` needs a prompt-version review same day |
| Hourly | `usageReconciler` corrections should be ~0 — sustained drift means an increment path is broken |
| Weekly | `channel.expiring` warnings — chase owners to reconnect before tokens die |
| Monthly | Restore drill (§9 above) |
