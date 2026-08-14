/**
 * Seed script (prompt.md §9 Phase 1 item 9): one workspace, one owner,
 * 10 products with variants, 20 FAQs, 5 conversations, 3 orders in different
 * states. IDEMPOTENT — runs clean twice in a row (upsert by natural keys).
 *
 * Usage: MONGODB_URI=... pnpm seed   (defaults to mongodb://127.0.0.1:27017/inboxbondhu)
 */
import mongoose from 'mongoose'
import {
  AuditLog, ChannelConnection, Conversation, Customer, KnowledgeItem, Membership,
  Message, Order, Product, User, Workspace, nextOrderCode, createIndexes,
} from './index.js'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function seedUlid(seed: number): string {
  let s = ''
  let h = seed
  for (let i = 0; i < 26; i += 1) {
    h = (h * 1103515245 + 12345) >>> 0
    s += CROCKFORD[h % 32]
  }
  return s
}

const DAY = 86400_000

export async function runSeed(uri: string): Promise<{
  products: number
  faqs: number
  conversations: number
  orders: number
}> {
  await mongoose.connect(uri)
  await createIndexes()

  // 1 owner
  const owner = await User.findOneAndUpdate(
    { email: 'owner@rupafashion.example' },
    {
      $setOnInsert: {
        ulid: seedUlid(1),
        // Argon2id placeholder — real registration path hashes in Phase 2.
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2VlZHNhbHQ$seedhashplaceholder',
        name: 'Rupa Owner',
        emailVerifiedAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )

  // 1 workspace
  const workspace = await Workspace.findOneAndUpdate(
    { slug: 'rupa-fashion' },
    {
      $setOnInsert: {
        name: 'Rupa Fashion',
        ownerId: owner._id,
        plan: 'trial',
        trialEndsAt: new Date(Date.now() + 14 * DAY),
        businessHours: {
          enabled: true,
          days: Array.from({ length: 7 }, (_, day) => ({
            day, open: '10:00', close: '22:00', closed: day === 5,
          })),
          awayMessage: 'Amra ekhon offline. Sokal 10 tar por reply pabo, dhonnobad!',
        },
        aiConfig: {
          enabled: true, tone: 'friendly', autoReplyEnabled: true,
          confidenceThreshold: 0.7, handoverKeywords: ['complain', 'refund', 'manager'],
          maxDiscountPercent: 10, promptVersion: 'v1',
        },
        deliveryZones: [
          { name: 'Dhaka', feeMinor: 6000, etaDays: 1 },
          { name: 'Outside Dhaka', feeMinor: 12000, etaDays: 3 },
        ],
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )
  const ws = workspace._id

  await Membership.findOneAndUpdate(
    { workspaceId: ws, userId: owner._id, removedAt: null },
    { $setOnInsert: { role: 'owner', joinedAt: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )

  // 1 connected page (fake ciphertext — Phase 3 owns real AES-256-GCM)
  const channel = await ChannelConnection.findOneAndUpdate(
    // Tenant filter from OUR workspace — I18's global uniqueness still protects
    // against another workspace claiming the same page (E11000).
    { workspaceId: ws, provider: 'facebook', externalPageId: 'seed-page-1001' },
    {
      $setOnInsert: {
        workspaceId: ws,
        pageName: 'Rupa Fashion BD',
        accessTokenCipher: 'seed-cipher',
        accessTokenIv: Buffer.alloc(12).toString('base64'),
        accessTokenTag: Buffer.alloc(16).toString('base64'),
        scopes: ['pages_messaging'],
        subscribedFields: ['messages', 'messaging_postbacks'],
        connectedBy: owner._id,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )

  // 10 products with variants
  const productNames = [
    'Cotton Jama', 'Silk Saree', 'Denim Panjabi', 'Linen Kurti', 'Georgette Orna',
    'Embroidered Salwar', 'Printed Fatua', 'Karchupi Lehenga', 'Handloom Shari', 'Batik Shirt',
  ]
  const products = []
  for (let i = 0; i < 10; i += 1) {
    const sku = `SEED-${String(i + 1).padStart(3, '0')}`
    const p = await Product.findOneAndUpdate(
      { workspaceId: ws, sku },
      {
        $setOnInsert: {
          name: productNames[i],
          description: `${productNames[i]} — comfortable, deshi fabric.`,
          category: i % 2 === 0 ? 'women' : 'men',
          basePriceMinor: (79900 + i * 10000), // ৳799 …
          variants: [
            { sku: `${sku}-R-M`, name: 'Red / M', attributes: { color: 'Red', size: 'M' }, stock: 10, reserved: 0, isActive: true },
            { sku: `${sku}-B-L`, name: 'Blue / L', attributes: { color: 'Blue', size: 'L' }, stock: 5, reserved: 0, isActive: true },
          ],
          status: 'active',
          searchText: ' ',
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )
    products.push(p)
  }

  // 20 approved FAQs
  const faqs: [string, string][] = [
    ['Delivery charge koto?', 'Dhaka city te 60 taka, Dhaka r baire 120 taka.'],
    ['Koto din e delivery hoy?', 'Dhaka te 1 din, baire 2-3 din lage.'],
    ['Cash on delivery ache?', 'Ji, amra cash on delivery support kori.'],
    ['Return policy ki?', '3 diner moddhe unused product return kora jabe.'],
    ['Size exchange kora jay?', 'Ji, delivery r 3 diner moddhe size exchange free.'],
    ['Bkash e payment kora jabe?', 'Ekhon shudhu cash on delivery cholche.'],
    ['Order cancel korbo kivabe?', 'Confirm er age amader message korlei cancel hobe.'],
    ['Stock e ache kina janbo kivabe?', 'Product name likhe pathan, amra check kore janabo.'],
    ['Advance payment lagbe?', 'Na, kono advance lagbe na. COD available.'],
    ['Dhaka r baire delivery hoy?', 'Ji, sara Bangladesh e courier e pathai.'],
    ['Office pickup kora jay?', 'Dukkhito, ekhon shudhu home delivery.'],
    ['Washing instruction ki?', 'Normal thanda panite dhute parben, bleach korben na.'],
    ['Gift wrap kora jay?', 'Ji, order note likhe din, free gift wrap kore dei.'],
    ['Kon courier e pathan?', 'Pathao Courier ar Steadfast e pathai.'],
    ['Order track korbo kivabe?', 'Shipped howar por tracking number pathiye dei.'],
    ['Fabric ki?', 'Prottekta product er description e fabric details deya ache.'],
    ['Discount ache?', 'Seasonal offer gulo page e announce kori.'],
    ['Wholesale nite chai', 'Wholesale er jonno amader inbox e "wholesale" likhun.'],
    ['Size chart ache?', 'Ji, prottekta product er chobi te size chart deya ache.'],
    ['Customer care number ki?', 'Inbox ei sob theke druto reply paben.'],
  ]
  for (const [question, answer] of faqs) {
    await KnowledgeItem.findOneAndUpdate(
      { workspaceId: ws, question },
      {
        $setOnInsert: {
          answer, status: 'approved', category: 'general',
          keywords: [], searchText: ' ',
          createdBy: owner._id, approvedBy: owner._id,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )
  }

  // 5 customers + conversations + a message each
  const conversations = []
  for (let i = 0; i < 5; i += 1) {
    const customer = await Customer.findOneAndUpdate(
      { workspaceId: ws, provider: 'facebook', externalUserId: `seed-psid-${i + 1}` },
      {
        $setOnInsert: {
          displayName: `Customer ${i + 1}`,
          firstSeenAt: new Date(Date.now() - (i + 1) * DAY),
          lastSeenAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )
    let conv = await Conversation.findOne({ workspaceId: ws, customerId: customer._id }).exec()
    if (!conv) {
      conv = await Conversation.create({
        workspaceId: ws,
        channelConnectionId: channel._id,
        customerId: customer._id,
        status: i < 3 ? 'open' : 'resolved',
        mode: i % 2 === 0 ? 'ai' : 'human',
        lastMessageAt: new Date(Date.now() - i * 3600_000),
        lastMessagePreview: 'dam koto?',
        lastMessageDirection: 'inbound',
        metaWindowExpiresAt: new Date(Date.now() + DAY),
        purgeAfter: new Date(Date.now() + 90 * DAY),
      })
      await Message.create({
        workspaceId: ws,
        conversationId: conv._id,
        direction: 'inbound',
        author: { type: 'customer' },
        contentType: 'text',
        text: `${productNames[i]} er dam koto?`,
        providerMessageId: `seed-mid-${i + 1}`,
        status: 'delivered',
      })
    }
    conversations.push(conv)
  }

  // 3 orders in different states
  const orderStates: ['Collecting' | 'Confirmed' | 'Delivered', 'Unpaid' | 'Paid'][] = [
    ['Collecting', 'Unpaid'],
    ['Confirmed', 'Unpaid'],
    ['Delivered', 'Paid'], // note: COD Delivered+Unpaid is ALSO legal (ADR-008)
  ]
  const year = 2026
  for (let i = 0; i < 3; i += 1) {
    const exists = await Order.findOne({
      workspaceId: ws,
      conversationId: conversations[i]!._id,
    }).exec()
    if (exists) continue
    const product = products[i]!
    const variant = product.variants[0]!
    const { orderNumber, orderCode } = await nextOrderCode(String(ws), year)
    const unit = variant.priceMinor ?? product.basePriceMinor
    const [fulfillment, payment] = orderStates[i]!
    await Order.create({
      workspaceId: ws,
      orderNumber,
      orderYear: year,
      orderCode,
      conversationId: conversations[i]!._id,
      customerId: conversations[i]!.customerId,
      items: [{
        productId: product._id,
        variantSku: variant.sku, // variants[].sku → items[].variantSku (DB-15)
        nameSnapshot: product.name,
        variantNameSnapshot: variant.name,
        unitPriceMinor: unit,
        quantity: 1,
        lineTotalMinor: unit,
      }],
      subtotalMinor: unit,
      discountMinor: 0,
      deliveryFeeMinor: 6000,
      totalMinor: unit + 6000,
      deliveryZone: 'Dhaka',
      deliveryAddress: `House ${i + 1}, Road 2, Dhanmondi, Dhaka`,
      recipientName: `Customer ${i + 1}`,
      recipientPhone: `0171234567${i}`,
      fulfillmentStatus: fulfillment,
      paymentStatus: payment,
      paymentMethod: 'cod',
      statusHistory: [{ from: 'Collecting', to: fulfillment, at: new Date(), byType: 'system' }],
      createdByType: 'ai',
      confirmedAt: fulfillment === 'Collecting' ? null : new Date(),
      purgeAfter: new Date(Date.now() + 90 * DAY),
    })
  }

  await AuditLog.create({
    workspaceId: ws,
    actorId: 'system',
    actorType: 'system',
    action: 'seed.completed',
    resourceType: 'workspace',
    resourceId: String(ws),
    requestId: seedUlid(Date.now() % 100000),
  })

  const counts = {
    products: await Product.countDocuments({ workspaceId: ws }).exec(),
    faqs: await KnowledgeItem.countDocuments({ workspaceId: ws }).exec(),
    conversations: await Conversation.countDocuments({ workspaceId: ws }).exec(),
    orders: await Order.countDocuments({ workspaceId: ws }).exec(),
  }
  console.log(`seed complete: workspace=rupa-fashion ${JSON.stringify(counts)}`)
  await mongoose.disconnect()
  return counts
}

// CLI entry: `pnpm seed` / `tsx packages/core/src/db/seed.ts`
// Env access goes through packages/config (agent.md §4.1) — the Phase 1
// OPEN QUESTION about direct process.env access is now resolved.
const isMain = process.argv[1]?.endsWith('seed.ts') ?? false
if (isMain) {
  const { loadSeedConfig } = await import('@inboxbondhu/config')
  runSeed(loadSeedConfig().MONGODB_URI).catch((err) => {
    console.error('seed failed:', err)
    process.exitCode = 1
  })
}
