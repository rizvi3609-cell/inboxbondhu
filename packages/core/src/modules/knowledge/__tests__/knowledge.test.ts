/**
 * MOD-07 tests — DoD #4: a draft FAQ is PROVABLY unreachable by retrieval.
 * Plus: approve flow, edit-reverts-approval, archive, the 500/2000 asymmetry.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { CreateKnowledgeBody } from '@inboxbondhu/contracts'
import {
  KnowledgeItem, Membership, User, Workspace, createIndexes,
  KnowledgeService, retrieveApprovedFaqs,
} from '../../../index.js'
import { makeTenantContext, type TenantContext } from '../../../kernel/tenantContext.js'
import { dropData, fakeUlid, startDb, stopDb } from '../../../__tests__/setupDb.js'

let svc: KnowledgeService

beforeAll(async () => {
  await startDb()
  await createIndexes() // text index I37 needed for retrieval
}, 300_000)
afterAll(async () => {
  await stopDb()
})
beforeEach(async () => {
  await dropData()
  svc = new KnowledgeService()
})

async function fixture(): Promise<{ ws: string; ctx: TenantContext }> {
  const owner = await User.create({
    ulid: fakeUlid(), email: `o${Math.random().toString(36).slice(2)}@x.example`,
    passwordHash: 'h', name: 'Owner Person', emailVerifiedAt: new Date(),
  })
  const ws = await Workspace.create({
    name: 'Rupa Fashion', slug: `rupa-${Math.random().toString(36).slice(2, 8)}`, ownerId: owner._id,
    businessHours: { enabled: false, days: Array.from({ length: 7 }, (_, day) => ({ day, open: '09:00', close: '21:00', closed: false })) },
    aiConfig: {},
  })
  await Membership.create({ workspaceId: ws._id, userId: owner._id, role: 'admin', joinedAt: new Date() })
  return {
    ws: String(ws._id),
    ctx: makeTenantContext({ workspaceId: String(ws._id), userId: String(owner._id), role: 'admin', requestId: fakeUlid() }),
  }
}

describe('DoD — a draft FAQ is provably unreachable by retrieval', () => {
  it('retrieval returns approved only; draft and archived are invisible', async () => {
    const { ws, ctx } = await fixture()

    const draft = await svc.create(ctx, {
      question: 'Delivery charge koto Dhaka te?',
      answer: 'DRAFT: Dhaka te 60 taka.',
    })
    if (!draft.ok) throw draft.error

    const toApprove = await svc.create(ctx, {
      question: 'Delivery time koto din Dhaka city te?',
      answer: 'Dhaka te 1 din, baire 2-3 din.',
    })
    if (!toApprove.ok) throw toApprove.error
    await svc.approve(ctx, toApprove.value['id'] as string)

    const toArchive = await svc.create(ctx, {
      question: 'Delivery courier kon company?',
      answer: 'Pathao Courier e pathai.',
    })
    if (!toArchive.ok) throw toArchive.error
    await svc.approve(ctx, toArchive.value['id'] as string)
    // Archive an APPROVED one — must vanish from retrieval too.
    const archRow = await KnowledgeItem.findOne({ _id: toArchive.value['id'], workspaceId: ws }).exec()
    await svc.archive({ ...ctx }, String(archRow!._id))

    const hits = await retrieveApprovedFaqs(ws, 'delivery Dhaka')
    expect(hits.length).toBeGreaterThanOrEqual(1)
    const ids = hits.map((h) => h.id)
    expect(ids).toContain(toApprove.value['id']) // approved: reachable
    expect(ids).not.toContain(draft.value['id']) // draft: unreachable
    expect(ids).not.toContain(toArchive.value['id']) // archived: unreachable
    // And no draft text leaks through any hit.
    expect(hits.every((h) => !h.answer.startsWith('DRAFT:'))).toBe(true)
  })

  it('cross-tenant: another workspace’s approved FAQs are not retrievable', async () => {
    const a = await fixture()
    const b = await fixture()
    const item = await svc.create(a.ctx, { question: 'Return policy ki bhai?', answer: '3 diner moddhe return.' })
    if (!item.ok) throw item.error
    await svc.approve(a.ctx, item.value['id'] as string)

    expect(await retrieveApprovedFaqs(a.ws, 'return policy')).toHaveLength(1)
    expect(await retrieveApprovedFaqs(b.ws, 'return policy')).toHaveLength(0)
  })
})

describe('approve flow', () => {
  it('create starts draft; approve sets approved + approvedBy; only draft approvable', async () => {
    const { ws, ctx } = await fixture()
    const item = await svc.create(ctx, { question: 'COD ache apnader?', answer: 'Ji, cash on delivery ache.' })
    if (!item.ok) throw item.error
    expect(item.value['status']).toBe('draft')

    const approved = await svc.approve(ctx, item.value['id'] as string)
    expect(approved.ok).toBe(true)
    const row = await KnowledgeItem.findOne({ _id: item.value['id'], workspaceId: ws }).exec()
    expect(row!.status).toBe('approved')
    expect(String(row!.approvedBy)).toBe(ctx.userId)

    const again = await svc.approve(ctx, item.value['id'] as string)
    expect(!again.ok && again.error.code).toBe('INVALID_STATE_TRANSITION')
  })

  it('editing an approved answer reverts it to draft (must re-approve)', async () => {
    const { ws, ctx } = await fixture()
    const item = await svc.create(ctx, { question: 'Size exchange hoy ki?', answer: 'Ji, 3 diner moddhe free.' })
    if (!item.ok) throw item.error
    await svc.approve(ctx, item.value['id'] as string)

    const row = await KnowledgeItem.findOne({ _id: item.value['id'], workspaceId: ws }).exec()
    const updated = await svc.update(ctx, String(row!._id), row!.version, { answer: 'Notun policy: 7 din.' })
    expect(updated.ok).toBe(true)
    const fresh = await KnowledgeItem.findOne({ _id: item.value['id'], workspaceId: ws }).exec()
    expect(fresh!.status).toBe('draft') // un-approved by the edit
    expect(fresh!.approvedBy).toBeNull()
    // And retrieval no longer sees it.
    expect((await retrieveApprovedFaqs(ws, 'size exchange')).map((h) => h.id)).not.toContain(String(row!._id))
  })
})

describe('the 500/2000 asymmetry (gotcha #7) — do not harmonise', () => {
  it('API edge rejects answers over 500; the DB model accepts up to 2000', async () => {
    // API edge (Zod contract): 501 chars → rejected.
    const parsed = CreateKnowledgeBody.safeParse({ question: 'Boro answer test question?', answer: 'x'.repeat(501) })
    expect(parsed.success).toBe(false)
    expect(CreateKnowledgeBody.safeParse({ question: 'Thik ache question?', answer: 'x'.repeat(500) }).success).toBe(true)

    // DB ceiling: 2000 fine, 2001 rejected — proves the ceilings DIFFER.
    const { ws } = await fixture()
    await expect(KnowledgeItem.create({
      workspaceId: ws, question: 'DB ceiling test question?', answer: 'y'.repeat(2000), searchText: ' ',
    })).resolves.toBeDefined()
    await expect(KnowledgeItem.create({
      workspaceId: ws, question: 'DB overflow test question?', answer: 'y'.repeat(2001), searchText: ' ',
    })).rejects.toThrow()
  })
})

describe('archive + validation', () => {
  it('DELETE archives; keywords lowercase; max 20 keywords enforced at edge', async () => {
    const { ws, ctx } = await fixture()
    const item = await svc.create(ctx, {
      question: 'Keyword test question ki?', answer: 'Answer here thik ache.',
      keywords: ['Delivery', 'CHARGE'],
    })
    if (!item.ok) throw item.error
    const row = await KnowledgeItem.findOne({ _id: item.value['id'], workspaceId: ws }).exec()
    expect(row!.get('keywords')).toEqual(['delivery', 'charge'])

    const archived = await svc.archive(ctx, String(row!._id))
    expect(archived.ok).toBe(true)
    expect((await KnowledgeItem.findOne({ _id: row!._id, workspaceId: ws }).exec())!.status).toBe('archived')

    const tooMany = CreateKnowledgeBody.safeParse({
      question: 'Onek keyword question?', answer: 'A.'.repeat(3),
      keywords: Array.from({ length: 21 }, (_, i) => `k${i}`),
    })
    expect(tooMany.success).toBe(false)
  })
})
