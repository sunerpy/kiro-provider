import { describe, expect, test } from "bun:test";
import { fidelityFixture } from "./responses-fidelity-helpers.js";

describe("Fable Responses routing", () => {
  // Kiro CreateResponse rejects Fable 5.1; Fable 5.2 has no native evidence yet.
  test.each(["claude-fable-5-1", "claude-fable-5-2"])(
    "routes %s through stateless stateful continuation instead of native CreateResponse",
    async (model) => {
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
    },
  );
});

describe("Claude 5.5 Responses routing", () => {
  // Without Fable's CreateResponse rejection, these follow the Opus 5.5 precedent.
  test.each(["claude-sonnet-5-5", "claude-haiku-5-5"])(
    "routes %s to native CreateResponse by default",
    async (model) => {
      const fixture = fidelityFixture();
      try {
        const response = await fixture.send({ model, input: "q" });

        expect(response.status).toBe(200);
        expect(response.headers.get("X-Kiro-Transport")).toBe("native");
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.canonical).toHaveLength(0);
      } finally {
        fixture.database.close();
      }
    },
  );
});
