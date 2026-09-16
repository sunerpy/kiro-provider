import { describe, expect, test } from "bun:test";
import { fidelityFixture } from "./responses-fidelity-helpers.js";

describe("Fable 5.1 Responses routing", () => {
  test("routes the public model through stateless stateful continuation because Kiro CreateResponse rejects it", async () => {
    const model = "claude-fable-5-1";
    const fixture = fidelityFixture();
    try {
      const response = await fixture.send({ model, input: "q" });

      expect(response.status).toBe(200);
      expect(response.headers.get("X-Kiro-Transport")).toBe("stateless");
      expect(fixture.requests).toHaveLength(0);
      expect(fixture.canonical).toHaveLength(1);
      expect(fixture.canonical[0]?.model).toBe(model);
      const first = (await response.json()) as Record<string, unknown>;
      expect(first).toMatchObject({
        object: "response",
        status: "completed",
        model,
        store: true,
      });

      const continued = await fixture.send({
        model,
        input: "follow up",
        previous_response_id: first.id,
      });
      expect(continued.status).toBe(200);
      expect(continued.headers.get("X-Kiro-Transport")).toBe("stateless");
      expect(fixture.requests).toHaveLength(0);
      expect(fixture.canonical).toHaveLength(2);
    } finally {
      fixture.database.close();
    }
  });
});
