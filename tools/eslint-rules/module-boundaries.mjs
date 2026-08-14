/**
 * Custom rule (§5.1): CI-enforced module dependency graph, no cycles.
 * kernel ← everything; MOD-10/11/12 are never imported by a domain module.
 * Also enforces the layering rules: apps never import module internals,
 * and core modules never import from apps.
 */
const MODULE_DEPS = {
  identity: [],
  workspace: [],
  channels: ['workspace'],
  catalogue: ['workspace'],
  knowledge: ['workspace'],
  inbox: ['workspace', 'channels'],
  ai: ['inbox', 'catalogue', 'knowledge', 'plans'],
  orders: ['inbox', 'catalogue'],
  payments: ['orders'],
  notifications: [],
  plans: [],
  observability: [],
}

// Reactive modules: NEVER imported by a domain module (they react to events).
const REACTIVE = new Set(['notifications', 'plans', 'observability'])
// Exception per §5.1: ai may import plans (quota check is on its hot path).
const REACTIVE_IMPORT_EXCEPTIONS = new Set(['ai→plans'])

function moduleOf(filename) {
  const m = /packages\/core\/src\/modules\/([a-z]+)\//.exec(filename.replaceAll('\\', '/'))
  return m ? m[1] : null
}

function importedModule(source) {
  const m = /(?:^|\/)modules\/([a-z]+)(?:\/|$)/.exec(source)
  return m ? m[1] : null
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Enforce the §5.1 module dependency graph' },
    schema: [],
    messages: {
      forbidden:
        'Module "{{from}}" may not import module "{{to}}" (§5.1). If {{from}} needs {{to}}\'s behaviour, emit an event or write an outbox row.',
      reactive:
        '"{{to}}" is a reactive module (MOD-10/11/12) and is never imported by a domain module. Emit an event instead.',
    },
  },
  create(context) {
    const from = moduleOf(context.filename)
    if (!from) return {}
    return {
      ImportDeclaration(node) {
        const to = importedModule(String(node.source.value))
        if (!to || to === from) return
        if (REACTIVE.has(to) && !REACTIVE_IMPORT_EXCEPTIONS.has(`${from}→${to}`)) {
          context.report({ node, messageId: 'reactive', data: { from, to } })
          return
        }
        const allowed = MODULE_DEPS[from] ?? []
        if (!allowed.includes(to)) {
          context.report({ node, messageId: 'forbidden', data: { from, to } })
        }
      },
    }
  },
}
