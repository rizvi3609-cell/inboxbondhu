/**
 * In-memory MetaClient mock — deterministic, records calls, scriptable
 * failures. Used by worker tests and the Phase 3 integration suite.
 */
import {
  MetaSendError,
  type MetaClient, type MetaMediaDownload, type MetaPage, type MetaSendResult,
} from '../types.js'

export interface MockMetaState {
  sent: Array<{ pageToken: string; recipient: string; text: string; mid: string }>
  subscribed: string[]
  unsubscribed: string[]
  /** Script the next sendMessage to fail. */
  nextSendFailure: { permanent: boolean; code: string } | null
  pageByCode: Record<string, MetaPage>
}

export function createMockMetaClient(overrides: Partial<MockMetaState> = {}): {
  client: MetaClient
  state: MockMetaState
} {
  let midCounter = 0
  const state: MockMetaState = {
    sent: [],
    subscribed: [],
    unsubscribed: [],
    nextSendFailure: null,
    pageByCode: {
      'good-code': {
        pageId: '108888001',
        pageName: 'Rupa Fashion BD',
        accessToken: 'EAAG-long-lived-page-token-secret',
        scopes: ['pages_messaging', 'pages_manage_metadata'],
      },
    },
    ...overrides,
  }

  const client: MetaClient = {
    async exchangeCodeForPage(code: string): Promise<MetaPage> {
      const page = state.pageByCode[code]
      if (!page) throw new MetaSendError('invalid oauth code', true, 'OAUTH_CODE_INVALID')
      return page
    },
    async subscribePageWebhooks(pageId: string): Promise<void> {
      state.subscribed.push(pageId)
    },
    async unsubscribePageWebhooks(pageId: string): Promise<void> {
      state.unsubscribed.push(pageId)
    },
    async sendMessage(pageToken: string, recipient: string, text: string): Promise<MetaSendResult> {
      if (state.nextSendFailure) {
        const f = state.nextSendFailure
        state.nextSendFailure = null
        throw new MetaSendError(`scripted failure ${f.code}`, f.permanent, f.code)
      }
      midCounter += 1
      const mid = `mid.mock${String(midCounter).padStart(6, '0')}`
      state.sent.push({ pageToken, recipient, text, mid })
      return { providerMessageId: mid }
    },
    async downloadMedia(): Promise<MetaMediaDownload> {
      return { buffer: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png' }
    },
  }
  return { client, state }
}
