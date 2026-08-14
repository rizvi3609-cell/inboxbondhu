/**
 * §10.1 — nine stages, ONE 15 s Deadline (INV-09). A stage that cannot fit
 * in the remaining budget is SKIPPED, not started. Every exit path is either
 * a queued reply that passed the gates, or a handover. Never a hang.
 */
import mongoose from 'mongoose'
import { Deadline } from '../../kernel/deadline.js'
import { DhakaTime } from '../../kernel/dhakaTime.js'
import {
  AuditLog, Conversation, Message, UsageLedger, Workspace,
} from '../../db/models/index.js'
import type { LlmClient } from '@inboxbondhu/integrations'
import { AiDecision, HANDOVER_INTENTS, detectInjection, isPureBengali } from './schema.js'
import type { Retriever, RetrievedDoc } from './retrieval.js'
import { assemblePrompt, preclassifyIntent, PROMPT_VERSION_BUILTIN } from './prompt.js'
import { verifyGrounding } from './grounding.js'

export interface AiPipelineDeps {
  llm: LlmClient
  retriever: Retriever
  enqueueOutbound: (job: { workspaceId: string; requestId: string; payload: { messageId: string } }) => Promise<void>
  /** ৳ per 1M tokens in minor units — cost attribution. */
  costPerMTokensMinor?: number
  /** AI_DAILY_COST_CAP_MINOR from config — trigger 11. */
  dailyCostCapMinor?: number
  totalDeadlineMs?: number
  llmBudgetMs?: number
  now?: () => Date
}

export interface AiPipelineResult {
  outcome: 'replied' | 'handover' | 'skipped'
  handoverReason?: string
  intent?: string
  messageId?: string
  latencyMs: number
  groundingBlocked?: boolean
}

const STAGE_BUDGETS = {
  loadWindow: 150,
  preclassify: 800,
  retrieval: 700,
  assembly: 50,
  llm: 9000,
  parse: 2000,
  grounding: 300,
  policy: 100,
  enqueue: 50,
} as const

export async function runAiPipeline(
  workspaceId: string,
  conversationId: string,
  inboundMessageId: string,
  requestId: string,
  deps: AiPipelineDeps,
): Promise<AiPipelineResult> {
  const started = Date.now()
  const now = deps.now ?? (() => new Date())
  const deadline = Deadline.start(deps.totalDeadlineMs ?? 15_000)
  const latency = () => Date.now() - started

  const handover = async (reason: string, extra: {
    intent?: string; groundingBlocked?: boolean; audited?: string
  } = {}): Promise<AiPipelineResult> => {
    deadline.clear()
    await Conversation.updateOne(
      { _id: conversationId, workspaceId, mode: 'ai' },
      { $set: { mode: 'human', handoverReason: mapHandoverReason(reason), status: 'pending' } },
    ).exec()
    if (extra.audited) {
      await AuditLog.create({
        workspaceId, actorId: 'system', actorType: 'ai', actorRole: null,
        action: extra.audited, resourceType: 'conversation', resourceId: conversationId,
        after: { reason }, requestId,
      })
    }
    const result: AiPipelineResult = { outcome: 'handover', handoverReason: reason, latencyMs: latency() }
    if (extra.intent !== undefined) result.intent = extra.intent
    if (extra.groundingBlocked !== undefined) result.groundingBlocked = extra.groundingBlocked
    return result
  }

  try {
    // ── Preconditions: conversation still in AI mode, workspace AI on ──────
    const conversation = await Conversation.findOne({ _id: conversationId, workspaceId }).exec()
    if (!conversation || conversation.mode !== 'ai') {
      deadline.clear()
      return { outcome: 'skipped', latencyMs: latency() }
    }
    const workspace = await Workspace.findOne({ _id: workspaceId }).exec()
    const aiConfig = workspace?.aiConfig
    const businessHours = workspace?.businessHours
    if (!workspace || !aiConfig || !aiConfig.enabled || !aiConfig.autoReplyEnabled) {
      deadline.clear()
      return { outcome: 'skipped', latencyMs: latency() }
    }

    // ── Trigger 11: workspace cost cap (§10.7). The ledger is monthly
    // (usageLedger.periodKey YYYY-MM); the daily split arrives with plans in
    // P8 — the narrow interim caps the MONTH at 30× the daily cap so a
    // runaway is still bounded. Config flows through deps (never process.env).
    const periodKey = DhakaTime.dhakaPeriodKey(now())
    const ledger = await UsageLedger.findOne({ workspaceId, periodKey }).exec()
    const dailyCapMinor = deps.dailyCostCapMinor ?? 20_000
    if (ledger && ledger.aiCostMinor >= 30 * dailyCapMinor) {
      return handover('llm cost cap reached')
    }

    // ── Stage 1 (150 ms): last 12 messages ─────────────────────────────────
    deadline.assertRemaining(STAGE_BUDGETS.loadWindow)
    const window = await Message.find({ workspaceId, conversationId })
      .sort({ createdAt: -1 })
      .limit(12)
      .exec()
    const messages = window.reverse()
    const inbound = messages.find((m) => String(m._id) === inboundMessageId)
      ?? messages.filter((m) => m.direction === 'inbound').at(-1)
    const text = inbound?.text ?? ''

    // ── Trigger 7: non-text content ────────────────────────────────────────
    if (!text || (inbound && inbound.contentType !== 'text' && inbound.contentType !== 'postback')) {
      return handover('non-text content')
    }

    // ── Trigger 3: workspace handover keywords ─────────────────────────────
    const keywordHit = (aiConfig.handoverKeywords as string[]).find((k) =>
      k.length > 0 && text.toLowerCase().includes(k.toLowerCase()),
    )
    if (keywordHit) return handover(`handover keyword: ${keywordHit}`)

    // ── §10.6 rule 3: injection pre-filter → forced handover + audit ───────
    if (detectInjection(text)) {
      return handover('prompt injection suspected', { audited: 'ai.injection_suspected' })
    }

    // ── Trigger 8: pure Bengali script (ask-once then handover is the AI's
    // reply path; the narrow deterministic rule hands over — flagged) ───────
    if (isPureBengali(text)) {
      return handover('pure Bengali script')
    }

    // ── Trigger 9: 6 consecutive AI messages without a human touch ─────────
    let consecutiveAi = 0
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!
      if (m.direction === 'outbound' && m.author!.type === 'ai') consecutiveAi += 1
      else if (m.direction === 'outbound' && m.author!.type === 'agent') break
      else if (m.direction === 'inbound') continue
    }
    if (consecutiveAi >= 6) return handover('runaway guard: 6 consecutive AI messages')

    // ── Trigger 10: outside business hours + away message already sent ─────
    if (businessHours?.enabled) {
      const days = businessHours.days as Array<{ day: number; open: string; close: string; closed: boolean }>
      const within = DhakaTime.isWithinBusinessHours(days, now())
      if (!within) {
        const dayStart = DhakaTime.startOfDhakaDay(now())
        const awaySentToday = await Message.findOne({
          workspaceId, conversationId, direction: 'outbound',
          'author.type': 'system', createdAt: { $gte: dayStart },
        }).exec()
        if (awaySentToday) {
          return handover('outside business hours, away message already sent')
        }
        // Send the away message ONCE per customer per day (P-09), stay in AI mode.
        const away = businessHours.awayMessage ?? 'Amra ekhon offline. Business hours e reply pabo!'
        const awayMsg = await Message.create({
          workspaceId, conversationId, direction: 'outbound',
          author: { type: 'system' }, contentType: 'text', text: away, status: 'queued',
        })
        await deps.enqueueOutbound({ workspaceId, requestId, payload: { messageId: String(awayMsg._id) } })
        deadline.clear()
        return { outcome: 'replied', messageId: String(awayMsg._id), latencyMs: latency() }
      }
    }

    // ── Stage 2 (800 ms): intent pre-classification (rules at MVP) ─────────
    let intentHint = 'unknown'
    if (deadline.remaining() >= STAGE_BUDGETS.preclassify) {
      intentHint = preclassifyIntent(text)
    }

    // ── Trigger 6: same intent 3× consecutively (loop detection) ───────────
    const recentIntents = messages
      .filter((m) => m.direction === 'outbound' && m.author!.type === 'ai' && m.aiMeta?.intent)
      .slice(-3)
      .map((m) => m.aiMeta!.intent)
    if (recentIntents.length >= 3 && recentIntents.every((i) => i === intentHint)) {
      return handover(`loop detected: ${intentHint} asked 3x`)
    }

    // ── Stage 3 (700 ms): retrieval ────────────────────────────────────────
    let docs: RetrievedDoc[] = []
    if (deadline.remaining() >= STAGE_BUDGETS.retrieval) {
      docs = await deps.retriever.search(workspaceId, text)
    } // else: empty context → grounding forces handover for factual intents

    // ── Stage 4 (50 ms): prompt assembly ───────────────────────────────────
    deadline.assertRemaining(STAGE_BUDGETS.assembly)
    const promptVersion = aiConfig.promptVersion || PROMPT_VERSION_BUILTIN
    const prompt = assemblePrompt({
      tone: aiConfig.tone,
      maxDiscountPercent: aiConfig.maxDiscountPercent,
      recentMessages: messages.map((m) => ({
        direction: m.direction, authorType: m.author!.type, text: m.text ?? '',
      })),
      intentHint,
      customerMessage: text,
      docs,
    })

    // ── Stage 5 (9000 ms): the LLM call ────────────────────────────────────
    const llmBudget = Math.min(deps.llmBudgetMs ?? STAGE_BUDGETS.llm, deadline.remaining())
    if (llmBudget < 500) return handover('deadline: no budget for LLM call')
    const llmDeadline = deadline.child(llmBudget)
    let rawText: string
    let usage = { promptTokens: 0, completionTokens: 0 }
    let model = 'unknown'
    try {
      const response = await deps.llm.complete(prompt, { signal: llmDeadline.signal, maxTokens: 400 })
      rawText = response.text
      usage = response.usage
      model = response.model
      llmDeadline.clear()
    } catch {
      llmDeadline.clear()
      return handover('LLM call failed or timed out')
    }

    // ── Stage 6 (2000 ms): parse + exactly ONE repair retry ───────────────
    let decision: AiDecision | null = parseDecision(rawText)
    if (!decision) {
      if (deadline.remaining() >= 500) {
        const repairDeadline = deadline.child(Math.min(STAGE_BUDGETS.parse, deadline.remaining()))
        try {
          const zodError = AiDecision.safeParse(tryJson(rawText))
          const repair = await deps.llm.complete(
            {
              system: prompt.system,
              user: `${prompt.user}\n\nYour previous output was invalid: ${JSON.stringify(rawText.slice(0, 500))}\nZod error: ${zodError.success ? 'not JSON' : JSON.stringify(zodError.error.issues.slice(0, 3))}\nReturn ONLY valid AiDecision JSON.`,
            },
            { signal: repairDeadline.signal, maxTokens: 400 },
          )
          usage.promptTokens += repair.usage.promptTokens
          usage.completionTokens += repair.usage.completionTokens
          decision = parseDecision(repair.text)
          repairDeadline.clear()
        } catch {
          repairDeadline.clear()
        }
      }
      if (!decision) {
        // NEVER a third attempt (§10.2). Log prompt/response for debugging (PRD §2.7).
        await AuditLog.create({
          workspaceId, actorId: 'system', actorType: 'ai', actorRole: null,
          action: 'ai.parse_failed', resourceType: 'conversation', resourceId: conversationId,
          after: { rawSample: rawText.slice(0, 400), promptVersion }, requestId,
        })
        return handover('AiDecision parse failed after one repair')
      }
    }

    const costMinor = Math.ceil(((usage.promptTokens + usage.completionTokens) / 1_000_000) * (deps.costPerMTokensMinor ?? 3000))

    // ── Trigger 1: confidence below threshold ──────────────────────────────
    if (decision.confidence < aiConfig.confidenceThreshold) {
      await recordAiMeta(workspaceId, conversationId, decision, { model, promptVersion, latencyMs: latency(), costMinor, blocked: false })
      return handover(`confidence ${decision.confidence} < ${aiConfig.confidenceThreshold}`, { intent: decision.intent })
    }
    // ── Trigger 2: handover intents ────────────────────────────────────────
    if (HANDOVER_INTENTS.has(decision.intent) || decision.action === 'handover') {
      await recordAiMeta(workspaceId, conversationId, decision, { model, promptVersion, latencyMs: latency(), costMinor, blocked: false })
      return handover(decision.handoverReason ?? `intent ${decision.intent}`, { intent: decision.intent })
    }
    // ── Trigger 12: contradictory details mid-order ────────────────────────
    if (decision.extracted.phone) {
      const earlier = messages
        .filter((m) => m.direction === 'inbound' && m.text)
        .flatMap((m) => [...m.text!.matchAll(/01[3-9]\d{8}/g)].map((x) => x[0]))
      const distinct = new Set([...earlier, decision.extracted.phone])
      if (earlier.length > 0 && distinct.size > 1) {
        return handover('contradictory phone numbers mid-order', { intent: decision.intent })
      }
    }

    // ── Stage 7 (300 ms): grounding gate ───────────────────────────────────
    deadline.assertRemaining(STAGE_BUDGETS.grounding)
    const grounding = verifyGrounding(decision, docs, aiConfig.maxDiscountPercent)
    if (!grounding.ok) {
      await recordAiMeta(workspaceId, conversationId, decision, {
        model, promptVersion, latencyMs: latency(), costMinor,
        blocked: true, blockReason: grounding.blockReason,
      })
      return handover(`grounding: ${grounding.blockReason}`, { intent: decision.intent, groundingBlocked: true })
    }

    // ── Stage 8 (100 ms): policy checks ────────────────────────────────────
    deadline.assertRemaining(STAGE_BUDGETS.policy)
    // Stale-product check (PRD §2.7): cited product must still be active.
    const citedProductIds = decision.sourceIds.filter((id) =>
      docs.some((d) => d.id === id && d.type === 'product'),
    )
    if (citedProductIds.length > 0) {
      const { Product } = await import('../../db/models/index.js')
      const stillActive = await Product.countDocuments({
        _id: { $in: citedProductIds.map((id) => new mongoose.Types.ObjectId(id)) },
        workspaceId, status: 'active',
      }).exec()
      if (stillActive !== citedProductIds.length) {
        return handover('cited product archived mid-processing', { intent: decision.intent })
      }
    }

    if (!decision.reply) {
      return handover('no reply produced', { intent: decision.intent })
    }

    // ── Stage 9 (50 ms): insert + enqueue outbound ─────────────────────────
    deadline.assertRemaining(STAGE_BUDGETS.enqueue)
    const outMsg = await Message.create({
      workspaceId, conversationId, direction: 'outbound',
      author: { type: 'ai' }, contentType: 'text',
      text: decision.reply, status: 'queued',
      aiMeta: {
        intent: decision.intent, confidence: decision.confidence,
        sourceIds: decision.sourceIds.map((id) => new mongoose.Types.ObjectId(id)),
        model, promptVersion, latencyMs: latency(), costMinor,
        groundingBlocked: false,
      },
    })
    await Conversation.updateOne(
      { _id: conversationId, workspaceId },
      {
        $set: {
          lastMessageAt: now(), lastMessagePreview: decision.reply.slice(0, 140),
          lastMessageDirection: 'outbound',
        },
        $inc: { messageCount: 1 },
      },
    ).exec()
    await UsageLedger.updateOne(
      { workspaceId, periodKey },
      { $inc: { aiRepliesGenerated: 1, aiCostMinor: costMinor } },
    ).exec()
    await deps.enqueueOutbound({ workspaceId, requestId, payload: { messageId: String(outMsg._id) } })

    deadline.clear()
    return { outcome: 'replied', intent: decision.intent, messageId: String(outMsg._id), latencyMs: latency() }
  } catch (err) {
    // Any unbudgeted failure (incl. deadline aborts): handover, never hang.
    return handover(`pipeline error: ${(err as Error).message.slice(0, 120)}`)
  }
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // Models love fences — strip them once.
    const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
    try {
      return JSON.parse(stripped)
    } catch {
      return null
    }
  }
}

function parseDecision(text: string): AiDecision | null {
  const json = tryJson(text)
  if (json === null) return null
  const parsed = AiDecision.safeParse(json)
  return parsed.success ? parsed.data : null
}

/** Map free-form reasons onto the conversation enum (Phase 1 OPEN QUESTION values). */
function mapHandoverReason(reason: string): string {
  if (reason.includes('keyword')) return 'keyword'
  if (reason.includes('complaint')) return 'complaint'
  if (reason.includes('human_request') || reason.includes('injection')) return 'explicit_request'
  if (reason.includes('loop') || reason.includes('3x') || reason.includes('runaway')) return 'repeated_failure'
  return 'low_confidence'
}

async function recordAiMeta(
  workspaceId: string,
  conversationId: string,
  decision: AiDecision,
  meta: { model: string; promptVersion: string; latencyMs: number; costMinor: number; blocked: boolean; blockReason?: string },
): Promise<void> {
  // A blocked/handover decision still leaves an auditable trace: a system
  // message is NOT sent; the record is the audit log + (on send paths) aiMeta.
  await AuditLog.create({
    workspaceId, actorId: 'system', actorType: 'ai', actorRole: null,
    action: meta.blocked ? 'ai.grounding_blocked' : 'ai.decision',
    resourceType: 'conversation', resourceId: conversationId,
    after: {
      intent: decision.intent, confidence: decision.confidence, action: decision.action,
      sourceIds: decision.sourceIds, model: meta.model, promptVersion: meta.promptVersion,
      latencyMs: meta.latencyMs, costMinor: meta.costMinor,
      ...(meta.blockReason ? { blockReason: meta.blockReason } : {}),
    },
    requestId: '0'.repeat(26),
  })
}
