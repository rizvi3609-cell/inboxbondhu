/**
 * packages/logger — pino, structured JSON, one line per event (prompt.md §15.4).
 * Redaction happens HERE, not by developer discipline (INV-12): logs never
 * contain phone numbers, addresses, message bodies, or tokens.
 */
import { pino, type Logger } from 'pino'

/**
 * The §15.4 redaction list. Each key is redacted at any depth.
 * `text` covers messages.text; `rawPayload` covers webhookEvents.
 */
export const REDACT_KEYS = [
  'password',
  'passwordHash',
  'token',
  'refreshToken',
  'accessToken',
  'accessTokenCipher',
  'accessTokenIv',
  'accessTokenTag',
  'authorization',
  'cookie',
  'phone',
  'recipientPhone',
  'addressText',
  'deliveryAddress',
  'text',
  'rawPayload',
  'otp',
  'unlockOtpHash',
] as const

/** pino redact paths: every key at the top 4 nesting depths. */
function buildRedactPaths(): string[] {
  const paths: string[] = []
  for (const key of REDACT_KEYS) {
    paths.push(key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`)
  }
  return paths
}

export interface LoggerOptions {
  level?: string
  /** Test hook: capture the JSON lines instead of writing to stdout. */
  destination?: { write(line: string): void }
  base?: Record<string, unknown>
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  return pino(
    {
      level: opts.level ?? 'info',
      redact: { paths: buildRedactPaths(), censor: '[REDACTED]' },
      base: opts.base ?? {},
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
      },
    },
    opts.destination as never,
  )
}

/**
 * Child-logger helper: every log line carries requestId and (where known)
 * workspaceId, per §15.4.
 */
export function withRequestContext(
  logger: Logger,
  ctx: { requestId: string; workspaceId?: string },
): Logger {
  return logger.child(ctx.workspaceId ? ctx : { requestId: ctx.requestId })
}
