import { describe, expect, it } from 'vitest'
import { createLogger, withRequestContext, REDACT_KEYS } from '../index.js'

function capture(): { lines: string[]; destination: { write(l: string): void } } {
  const lines: string[] = []
  return { lines, destination: { write: (l: string) => void lines.push(l) } }
}

describe('logger — INV-12: no PII or secrets in any log line', () => {
  it('redacts every §15.4 key at the top level', () => {
    const { lines, destination } = capture()
    const log = createLogger({ destination })
    log.info(
      {
        password: 'hunter2',
        passwordHash: 'argon2id$x',
        token: 'tok_secret',
        refreshToken: 'rt_secret',
        accessToken: 'at_secret',
        authorization: 'Bearer xyz',
        cookie: 'sid=abc',
        phone: '01712345678',
        addressText: 'House 1, Dhanmondi',
        text: 'dam koto?',
        rawPayload: { entry: [] },
        otp: '123456',
      },
      'login attempt',
    )
    const line = lines[0]!
    expect(line).not.toContain('hunter2')
    expect(line).not.toContain('01712345678')
    expect(line).not.toContain('Dhanmondi')
    expect(line).not.toContain('dam koto')
    expect(line).not.toContain('tok_secret')
    expect(line).not.toContain('123456')
    expect(line).toContain('[REDACTED]')
  })

  it('redacts nested keys (job payloads, error contexts)', () => {
    const { lines, destination } = capture()
    const log = createLogger({ destination })
    log.info({
      job: { payload: { phone: '01898765432', text: 'address dilam' } },
      order: { recipientPhone: '01712345678', deliveryAddress: 'Road 2' },
    })
    const line = lines[0]!
    expect(line).not.toContain('01898765432')
    expect(line).not.toContain('address dilam')
    expect(line).not.toContain('01712345678')
    expect(line).not.toContain('Road 2')
  })

  it('redacts channel token cipher fields', () => {
    const { lines, destination } = capture()
    const log = createLogger({ destination })
    log.info({ connection: { accessTokenCipher: 'ciphertext', accessTokenIv: 'iv', accessTokenTag: 'tag' } })
    const line = lines[0]!
    expect(line).not.toContain('ciphertext')
  })

  it('emits structured single-line JSON with level and message intact', () => {
    const { lines, destination } = capture()
    const log = createLogger({ destination })
    log.warn({ workspaceId: 'ws1' }, 'quota at 80%')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(parsed['level']).toBe('warn')
    expect(parsed['msg']).toBe('quota at 80%')
    expect(parsed['workspaceId']).toBe('ws1')
  })

  it('withRequestContext threads requestId (+ workspaceId when known) onto every line', () => {
    const { lines, destination } = capture()
    const log = withRequestContext(createLogger({ destination }), {
      requestId: '01J5QC3H2M9WXYZABCDEF01234',
      workspaceId: 'ws42',
    })
    log.info('processing')
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(parsed['requestId']).toBe('01J5QC3H2M9WXYZABCDEF01234')
    expect(parsed['workspaceId']).toBe('ws42')
  })

  it('the redaction list covers the four INV-12 categories', () => {
    const keys = REDACT_KEYS as readonly string[]
    expect(keys).toContain('phone') // phone numbers
    expect(keys).toContain('addressText') // addresses
    expect(keys).toContain('text') // message bodies
    expect(keys).toContain('token') // tokens
  })
})
