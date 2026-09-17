import { describe, expect, test } from "bun:test";
import type { PipelineSessionAffinity } from "../src/core/pipeline-types.js";
import { handleMessages } from "../src/server/routes/messages.js";
import { fidelityFixture } from "./responses-fidelity-helpers.js";

describe("Claude branch identity at the Messages ingress", () => {
  test("uses bounded branch headers without combining siblings into the parent queue", async () => {
    const fixture = fidelityFixture();
    const observed: Array<PipelineSessionAffinity | undefined> = [];
    const send = async (agent?: string, session = "fixture-family", tenant = "fixture-tenant") => {
      const response = await handleMessages(
        new Request("http://fixture/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-claude-code-session-id": session,
            ...(agent === undefined ? {} : { "X-Claude-Code-Agent-Id": agent }),
          },
          body: JSON.stringify({
            model: "claude-opus-5",
            max_tokens: 1024,
            messages: [{ role: "user", content: "synthetic" }],
          }),
        }),
        fixture.config,
        {
          ...fixture.dependencies,
          tenantId: tenant,
          runPipeline: (options) => {
            observed.push(options.affinity);
            return fixture.dependencies.runPipeline?.(options) as Promise<Response>;
          },
        },
      );
      await response.text();
      expect(response.status).toBe(200);
    };
    try {
      await send();
      await send("child-a");
      await send("child-b");
      await send(" child-a ");
      await send("child-a", "other-family");
      await send("child-a", "fixture-family", "other-tenant");
      await send("a".repeat(257));
      expect(observed[1]?.source).toBe("anthropic.header.x-claude-code-agent-id");
      expect(observed[1]).toEqual(observed[3]);
      expect(new Set(observed.slice(0, 3).map((item) => item?.keyHash)).size).toBe(3);
      expect(observed[1]?.keyHash).not.toBe(observed[4]?.keyHash);
      expect(observed[1]?.keyHash).not.toBe(observed[5]?.keyHash);
      expect(observed[6]).toEqual(observed[0]);
      expect(JSON.stringify(observed)).not.toContain("child-a");
      expect(JSON.stringify(observed)).not.toContain("fixture-family");
    } finally {
      fixture.database.close();
    }
  });
});
