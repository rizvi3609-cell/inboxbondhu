/**
 * MOD-01 repository. THE one place in the codebase allowed to
 * `.select('+passwordHash')` (database.md §2.1 trap). Login and every
 * password re-auth (deactivate, ownership transfer) go through here.
 */
import { User } from '../../db/models/index.js'

export interface UserWithHash {
  _id: unknown
  email: string
  name: string
  status: string
  emailVerifiedAt: Date | null
  failedLoginCount: number
  lockedUntil: Date | null
  passwordHash: string
}

export async function findUserWithPasswordHash(
  filter: { email: string } | { _id: string },
): Promise<UserWithHash | null> {
  return (await User.findOne(filter).select('+passwordHash').exec()) as UserWithHash | null
}
