/**
 * AES-256-GCM envelope encryption for channel page tokens (§13 security
 * reflexes / architecture.md §1729): a per-record DEK wrapped by the KEK from
 * env (CHANNEL_TOKEN_MASTER_KEY), keyVersion enables rotation without
 * re-encrypting payloads. Tokens are NEVER logged, NEVER returned by any API,
 * NEVER in an error message.
 *
 * Stored shape (channelConnections): accessTokenCipher / accessTokenIv (12 B)
 * / accessTokenTag (16 B) / keyVersion.
 * The cipher field carries `wrappedDek.dekIv.dekTag.payloadCipher` base64
 * segments so the envelope stays self-contained in the three schema fields.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export interface EncryptedToken {
  accessTokenCipher: string
  accessTokenIv: string // base64, 12 bytes — payload nonce
  accessTokenTag: string // base64, 16 bytes — payload auth tag
  keyVersion: number
}

export interface Keyring {
  /** version → 32-byte KEK. Rotation adds a version; old rows still decrypt. */
  keys: Record<number, Buffer>
  currentVersion: number
}

export function makeKeyring(masterKeyBase64: string, version = 1): Keyring {
  const key = Buffer.from(masterKeyBase64, 'base64')
  if (key.length !== 32) throw new Error('CHANNEL_TOKEN_MASTER_KEY must be 32 bytes base64')
  return { keys: { [version]: key }, currentVersion: version }
}

export function encryptToken(plaintext: string, keyring: Keyring): EncryptedToken {
  const kek = keyring.keys[keyring.currentVersion]
  if (!kek) throw new Error(`no KEK for version ${keyring.currentVersion}`)

  // 1. Fresh per-record DEK encrypts the payload.
  const dek = randomBytes(32)
  const payloadIv = randomBytes(12)
  const payloadCipher = createCipheriv('aes-256-gcm', dek, payloadIv)
  const payload = Buffer.concat([payloadCipher.update(plaintext, 'utf8'), payloadCipher.final()])
  const payloadTag = payloadCipher.getAuthTag()

  // 2. KEK wraps the DEK.
  const dekIv = randomBytes(12)
  const wrapCipher = createCipheriv('aes-256-gcm', kek, dekIv)
  const wrappedDek = Buffer.concat([wrapCipher.update(dek), wrapCipher.final()])
  const dekTag = wrapCipher.getAuthTag()

  return {
    accessTokenCipher: [
      wrappedDek.toString('base64'),
      dekIv.toString('base64'),
      dekTag.toString('base64'),
      payload.toString('base64'),
    ].join('.'),
    accessTokenIv: payloadIv.toString('base64'),
    accessTokenTag: payloadTag.toString('base64'),
    keyVersion: keyring.currentVersion,
  }
}

export function decryptToken(encrypted: EncryptedToken, keyring: Keyring): string {
  const kek = keyring.keys[encrypted.keyVersion]
  if (!kek) throw new Error(`no KEK for keyVersion ${encrypted.keyVersion}`)

  const [wrappedDekB64, dekIvB64, dekTagB64, payloadB64] = encrypted.accessTokenCipher.split('.')
  if (!wrappedDekB64 || !dekIvB64 || !dekTagB64 || !payloadB64) {
    throw new Error('malformed token envelope')
  }

  // 1. Unwrap the DEK (auth tag verifies KEK + ciphertext integrity).
  const unwrap = createDecipheriv('aes-256-gcm', kek, Buffer.from(dekIvB64, 'base64'))
  unwrap.setAuthTag(Buffer.from(dekTagB64, 'base64'))
  const dek = Buffer.concat([unwrap.update(Buffer.from(wrappedDekB64, 'base64')), unwrap.final()])

  // 2. DEK decrypts the payload.
  const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(encrypted.accessTokenIv, 'base64'))
  decipher.setAuthTag(Buffer.from(encrypted.accessTokenTag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(payloadB64, 'base64')), decipher.final()]).toString('utf8')
}
