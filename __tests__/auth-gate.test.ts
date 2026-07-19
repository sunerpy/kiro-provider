import { describe, expect, test } from "bun:test"
import { checkApiKey } from "../src/server/auth-gate.js"

const API_KEYS = ["sk-valid-key", "sk-another-key"]

function requestWithAuth(header: string | undefined): Request {
  const headers: Record<string, string> = {}
  if (header !== undefined) {
    headers["Authorization"] = header
  }
  return new Request("http://localhost/v1/chat/completions", { headers })
}

async function expectEnvelope(response: Response, status: number, type: string): Promise<void> {
  expect(response.status).toBe(status)
  expect(response.headers.get("Content-Type")).toBe("application/json")
  const body = (await response.json()) as { error?: { message?: string; type?: string; code?: string } }
  expect(body.error).toBeDefined()
  expect(body.error?.type).toBe(type)
  expect(typeof body.error?.message).toBe("string")
}

describe("checkApiKey", () => {
  test("passes with a valid Bearer key", () => {
    const result = checkApiKey(requestWithAuth("Bearer sk-valid-key"), API_KEYS)
    expect(result.ok).toBe(true)
  })

  test("passes with any configured key", () => {
    const result = checkApiKey(requestWithAuth("Bearer sk-another-key"), API_KEYS)
    expect(result.ok).toBe(true)
  })

  test("rejects with 401 envelope when Authorization header is missing", async () => {
    const result = checkApiKey(requestWithAuth(undefined), API_KEYS)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      await expectEnvelope(result.response, 401, "authentication_error")
    }
  })

  test("rejects with 401 envelope for a non-Bearer scheme", async () => {
    const result = checkApiKey(requestWithAuth("Basic sk-valid-key"), API_KEYS)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      await expectEnvelope(result.response, 401, "authentication_error")
    }
  })

  test("rejects with 401 envelope for a wrong key", async () => {
    const result = checkApiKey(requestWithAuth("Bearer wrong-key"), API_KEYS)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      await expectEnvelope(result.response, 401, "authentication_error")
    }
  })
})
