import { describe, expect, test } from 'bun:test'
import { isRefreshTokenDead, toDeadReason } from '../src/kiro/health.js'

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
