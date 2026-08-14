/**
 * Custom rule (Phase 0 item 1): flags Mongoose query calls whose first
 * (filter) argument is an object literal without `workspaceId` — unless the
 * call site sets skipTenancy or targets an exempt/global model.
 *
 * This is LINT-TIME defence in depth. The runtime tenancy plugin remains the
 * hard gate; this rule catches the mistake before it runs.
 */
const GUARDED_METHODS = new Set([
  'find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace',
  'count', 'countDocuments', 'distinct', 'updateOne', 'updateMany',
  'deleteOne', 'deleteMany', 'exists',
])

// Models exempt from tenancy (global identity + pre-tenant dedupe).
const EXEMPT_MODELS = new Set(['User', 'Session', 'WebhookEvent', 'Workspace', 'OrderCounter'])

function objectHasWorkspaceKey(node) {
  if (!node || node.type !== 'ObjectExpression') return false
  return node.properties.some((p) => {
    if (p.type === 'SpreadElement') return true // can't see inside — trust it
    const key = p.key
    if (!key) return false
    const name = key.type === 'Identifier' ? key.name : key.type === 'Literal' ? String(key.value) : ''
    if (name === 'workspaceId' || name === '_id') return name === 'workspaceId'
    if (name === '$and' && p.value.type === 'ArrayExpression') {
      return p.value.elements.some((el) => objectHasWorkspaceKey(el))
    }
    return false
  })
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Every tenant-scoped Mongoose query must filter by workspaceId from TenantContext',
    },
    schema: [],
    messages: {
      missing:
        'Tenant-scoped query without workspaceId in the filter — the single highest-severity bug class (INV-01). Add `workspaceId: ctx.workspaceId` or use skipTenancy with an allowlisted caller.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee
        if (callee.type !== 'MemberExpression' || callee.property.type !== 'Identifier') return
        if (!GUARDED_METHODS.has(callee.property.name)) return

        // Only check direct Model.method(...) shapes where the model name is a
        // known PascalCase identifier; query-builder chains are runtime-guarded.
        const obj = callee.object
        if (obj.type !== 'Identifier') return
        if (!/^[A-Z]/.test(obj.name)) return
        if (EXEMPT_MODELS.has(obj.name)) return

        const filter = node.arguments[0]
        if (!filter) return // e.g. Model.find() — runtime plugin will throw
        if (filter.type !== 'ObjectExpression') return // dynamic filter — runtime guard
        if (objectHasWorkspaceKey(filter)) return

        // setOptions({ skipTenancy: true }) chained afterwards?
        const src = context.sourceCode.getText(node.parent?.parent ?? node.parent ?? node)
        if (src.includes('skipTenancy')) return

        context.report({ node, messageId: 'missing' })
      },
    }
  },
}
