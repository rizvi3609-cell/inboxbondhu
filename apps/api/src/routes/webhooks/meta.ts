/**
 * The webhook route — mounted BEFORE rate-limit/auth/csrf/tenant with ONLY
 * requestId + raw-body parsing in front (§8.1 note). Nothing that can touch
 * Mongo or Redis synchronously sits ahead of it.
 */
import { Router, raw, type Request } from 'express'
import type { Redis } from 'ioredis'
import { intakeWebhook, verifyChallengeToken } from '@inboxbondhu/core'

export interface MetaWebhookDeps {
  redis: Redis | null
  appSecret: string
  verifyToken: string
  journalDir: string
  enqueue: (job: { dedupeKey: string; requestId: string }) => Promise<void>
}

export function metaWebhookRouter(deps: MetaWebhookDeps): Router {
  const router = Router()

  // #3 GET /webhooks/meta — hub.challenge echo, constant-time token compare.
  router.get('/meta', (req, res) => {
    const mode = req.query['hub.mode']
    const token = req.query['hub.verify_token']
    const challenge = req.query['hub.challenge']
    if (mode === 'subscribe' && typeof token === 'string' && verifyChallengeToken(token, deps.verifyToken)) {
      res.status(200).send(String(challenge ?? ''))
      return
    }
    res.status(403).send('Forbidden')
  })

  // #4 POST /webhooks/meta — the ≤500 ms path. Raw body retained for HMAC.
  router.post('/meta', raw({ type: '*/*', limit: '256kb' }), (req: Request, res) => {
    void (async () => {
      const rawBody = req.body as Buffer
      const result = await intakeWebhook(
        Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(''),
        req.header('X-Hub-Signature-256'),
        deps.appSecret,
        req.requestId,
        {
          redis: deps.redis,
          enqueue: deps.enqueue,
          journalDir: deps.journalDir,
        },
      )
      // Step 6: 200. Never non-2xx for an internal fault — Meta would
      // retry then disable the subscription.
      res.status(200).json({ received: result.accepted + result.duplicates })
    })().catch(() => {
      // Even a programmer error must not break the 200 contract here.
      res.status(200).json({ received: 0 })
    })
  })

  return router
}
