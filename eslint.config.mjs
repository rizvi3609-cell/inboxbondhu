// ESLint 9 flat config — Phase 0 item 1.
// Enforces: no `any`/`@ts-ignore`, no process.env outside packages/config,
// module dependency boundaries (§5.1), and flags Mongoose calls whose first
// filter argument lacks workspaceId (defence-in-depth; the runtime tenancy
// plugin is the hard gate).
import tseslint from 'typescript-eslint'
import noTenantFilter from './tools/eslint-rules/no-missing-tenant-filter.mjs'
import moduleBoundaries from './tools/eslint-rules/module-boundaries.mjs'

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts', '**/generated/**', '**/.next/**', '**/next-env.d.ts'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    plugins: {
      inboxbondhu: {
        rules: {
          'no-missing-tenant-filter': noTenantFilter,
          'module-boundaries': moduleBoundaries,
        },
      },
    },
    rules: {
      // agent.md §4.1 hard rules
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': true }],
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read process.env only in packages/config (agent.md §4.1).',
        },
      ],
      'inboxbondhu/no-missing-tenant-filter': 'error',
      'inboxbondhu/module-boundaries': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // The ONE place allowed to read process.env — plus test setup and CLI entries.
    files: ['packages/config/**', '**/__tests__/**', '**/vitest.config.ts'],
    rules: {
      'no-restricted-properties': 'off',
    },
  },
  {
    // Tests may relax non-null for fixture ergonomics; `any` stays banned.
    // The tenant-filter rule is off in tests ONLY because the tenancy suite
    // deliberately writes violating queries to prove the runtime plugin throws.
    files: ['**/__tests__/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'inboxbondhu/no-missing-tenant-filter': 'off',
    },
  },
)
