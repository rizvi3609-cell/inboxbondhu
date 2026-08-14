import { z } from 'zod'

/** 24-hex Mongo ObjectId as a string (wire format). */
export const objectIdString = z.string().regex(/^[0-9a-fA-F]{24}$/, 'invalid ObjectId')

/** ULID — 26 Crockford base32 chars. */
export const ulidString = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'invalid ULID')

/**
 * Money — ALWAYS an integer in minor units (poisha). Field names end in `Minor`.
 * INV-02: no floats, ever.
 */
export const moneyMinor = z.number().int('money must be an integer in minor units').min(0)

/** BD mobile: 01[3-9] + 8 digits. */
export const bdPhone = z.string().regex(/^01[3-9]\d{8}$/, 'invalid BD mobile')

/**
 * RFC 5322-adequate email, normalised lowercase. Normalisation (lowercase+trim)
 * happens in a Mongoose pre-validate hook, never at the call site (database.md §2.1).
 */
export const emailAddress = z.string().trim().toLowerCase().email().max(320)

/** `YYYY-MM` billing period key, Asia/Dhaka calendar month. */
export const periodKey = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)

/** `HH:mm` 24h time. */
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

export const providerEnum = z.enum(['facebook', 'instagram'])

export const isoDate = z.date()
