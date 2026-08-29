import { describe, expect, test } from 'bun:test'
import { isQuotaExhausted, isRefreshTokenDead, toDeadReason } from '../src/kiro/health.js'

describe('toDeadReason', () => {
  test('preserves an existing refresh-token-dead reason', () => {
    const reason = 'Invalid refresh token returned by OIDC'

    expect(toDeadReason(reason)).toBe(reason)
    expect(isRefreshTokenDead(toDeadReason(reason))).toBe(true)
  })

  test('normalizes missing and transient reasons into permanent stored reasons', () => {
    expect(toDeadReason()).toBe('InvalidTokenException: Account needs re-authentication')
    expect(toDeadReason('network failed')).toBe('InvalidTokenException: network failed')
    expect(isRefreshTokenDead(toDeadReason('network failed'))).toBe(true)
  })
})

describe('isQuotaExhausted', () => {
  test('requires a known positive limit and used credits at or above it', () => {
    expect(isQuotaExhausted({ usedCount: 9_999, limitCount: 10_000 })).toBe(false)
    expect(isQuotaExhausted({ usedCount: 10_000, limitCount: 10_000 })).toBe(true)
    expect(isQuotaExhausted({ usedCount: 10_001, limitCount: 10_000 })).toBe(true)
    expect(isQuotaExhausted({ usedCount: 10_000, limitCount: 0 })).toBe(false)
  })

  test('treats observed paid overage as exhausted even without a known limit', () => {
    expect(isQuotaExhausted({ usedCount: 1, limitCount: 0, overageCount: 1 })).toBe(true)
  })
})
