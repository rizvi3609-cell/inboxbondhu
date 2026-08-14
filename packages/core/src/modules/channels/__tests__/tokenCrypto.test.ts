/**
 * AES-256-GCM envelope encryption tests — round-trip, tamper detection,
 * key rotation via keyVersion, and the never-plaintext guarantee.
 */
import { describe, expect, it } from 'vitest'
import { decryptToken, encryptToken, makeKeyring } from '../tokenCrypto.js'

const MASTER = Buffer.alloc(32, 7).toString('base64')
const TOKEN = 'EAAG-super-secret-page-token-1234567890'

describe('token envelope crypto', () => {
  it('round-trips a page token', () => {
    const keyring = makeKeyring(MASTER)
    const enc = encryptToken(TOKEN, keyring)
    expect(decryptToken(enc, keyring)).toBe(TOKEN)
  })

  it('never stores plaintext anywhere in the envelope', () => {
    const keyring = makeKeyring(MASTER)
    const enc = encryptToken(TOKEN, keyring)
    expect(JSON.stringify(enc)).not.toContain(TOKEN)
    expect(JSON.stringify(enc)).not.toContain('EAAG')
  })

  it('unique DEK + IV per record: same plaintext → different ciphertexts', () => {
    const keyring = makeKeyring(MASTER)
    const a = encryptToken(TOKEN, keyring)
    const b = encryptToken(TOKEN, keyring)
    expect(a.accessTokenCipher).not.toBe(b.accessTokenCipher)
    expect(a.accessTokenIv).not.toBe(b.accessTokenIv)
  })

  it('IV is 12 bytes, tag is 16 bytes (schema contract)', () => {
    const keyring = makeKeyring(MASTER)
    const enc = encryptToken(TOKEN, keyring)
    expect(Buffer.from(enc.accessTokenIv, 'base64')).toHaveLength(12)
    expect(Buffer.from(enc.accessTokenTag, 'base64')).toHaveLength(16)
  })

  it('GCM detects tampering with cipher, tag, or IV', () => {
    const keyring = makeKeyring(MASTER)
    const enc = encryptToken(TOKEN, keyring)
    const flip = (b64: string): string => {
      const buf = Buffer.from(b64, 'base64')
      buf[0] = buf[0]! ^ 0xff
      return buf.toString('base64')
    }
    expect(() => decryptToken({ ...enc, accessTokenTag: flip(enc.accessTokenTag) }, keyring)).toThrow()
    expect(() => decryptToken({ ...enc, accessTokenIv: flip(enc.accessTokenIv) }, keyring)).toThrow()
    const segs = enc.accessTokenCipher.split('.')
    segs[3] = flip(segs[3]!)
    expect(() => decryptToken({ ...enc, accessTokenCipher: segs.join('.') }, keyring)).toThrow()
  })

  it('keyVersion rotation: old rows decrypt with the old KEK, new rows use the new', () => {
    const oldRing = makeKeyring(MASTER, 1)
    const encOld = encryptToken(TOKEN, oldRing)

    const NEW_MASTER = Buffer.alloc(32, 9).toString('base64')
    const rotated = {
      keys: { 1: Buffer.from(MASTER, 'base64'), 2: Buffer.from(NEW_MASTER, 'base64') },
      currentVersion: 2,
    }
    // Old row still decrypts.
    expect(decryptToken(encOld, rotated)).toBe(TOKEN)
    // New rows carry version 2 and need the new KEK.
    const encNew = encryptToken(TOKEN, rotated)
    expect(encNew.keyVersion).toBe(2)
    expect(() => decryptToken(encNew, oldRing)).toThrow(/keyVersion/)
  })

  it('rejects a wrong-size master key', () => {
    expect(() => makeKeyring(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/)
  })
})
