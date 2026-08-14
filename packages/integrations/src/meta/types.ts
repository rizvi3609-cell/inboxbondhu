/**
 * Meta Graph API integration — types. The client is an INTERFACE so the
 * worker and tests run against __mocks__ and the vertical swap to the real
 * HTTP client is one file (packages/integrations rule: client·types·errors·__mocks__).
 */

export interface MetaPage {
  pageId: string
  pageName: string
  /** Long-lived Page access token — plaintext ONLY in memory, encrypted at rest. */
  accessToken: string
  scopes: string[]
}

export interface MetaSendResult {
  providerMessageId: string // "mid.xxx"
}

export interface MetaMediaDownload {
  buffer: Uint8Array
  mimeType: string
}

/** Classified send failure — drives retry vs permanent-fail (§9 Phase 3 item 6). */
export class MetaSendError extends Error {
  constructor(
    message: string,
    /** 4xx (user blocked page, window closed…) = permanent; 5xx/network = retryable. */
    readonly permanent: boolean,
    readonly code: string,
  ) {
    super(message)
    this.name = 'MetaSendError'
  }
}

export interface MetaClient {
  /** OAuth code → short-lived user token → long-lived Page token + page info. */
  exchangeCodeForPage(code: string, redirectUri: string): Promise<MetaPage>
  /** Subscribe the app to the page's webhook fields. */
  subscribePageWebhooks(pageId: string, pageAccessToken: string, fields: string[]): Promise<void>
  /** Send API. Throws MetaSendError on failure. */
  sendMessage(pageAccessToken: string, recipientPsid: string, text: string): Promise<MetaSendResult>
  /** Download an attachment from the (expiring) Meta CDN. */
  downloadMedia(url: string): Promise<MetaMediaDownload>
  /** Unsubscribe on disconnect (best effort). */
  unsubscribePageWebhooks(pageId: string, pageAccessToken: string): Promise<void>
}
