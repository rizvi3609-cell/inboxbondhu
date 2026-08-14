export { IdentityService, type IdentityConfig, type DeviceInfo, type IssuedSession } from './service.js'
export {
  hashPassword, verifyPassword, checkPasswordStrength, sha256Hex, hashIp,
  opaqueToken, generateOtp, signAccessToken, verifyAccessToken, type AccessClaims,
} from './crypto.js'
export { findUserWithPasswordHash } from './repository.js'
