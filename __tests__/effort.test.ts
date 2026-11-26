import { describe, expect, test } from "bun:test";
import {
  budgetToEffort,
  buildThinkingDisabledRequestFields,
  buildThinkingRequestFields,
  getDefaultEffort,
  getEffectiveEffort,
  getSupportedEffortLevels,
  resolveEffort,
  supportsAdaptiveThinkingDisplay,
  supportsEffort,
  supportsForcedOmittedThinkingDisplay,
  supportsXHighEffort,
} from "../src/kiro/effort.js";

describe("effort module", () => {
  describe("supportsEffort", () => {
    test("returns true for supported models", () => {
      expect(supportsEffort("claude-fable-5.1")).toBe(true);
      expect(supportsEffort("claude-opus-5")).toBe(true);
      expect(supportsEffort("claude-opus-4.8")).toBe(true);
      expect(supportsEffort("claude-opus-4.7")).toBe(true);
      expect(supportsEffort("claude-sonnet-4.6")).toBe(true);
      expect(supportsEffort("claude-sonnet-4.6-1m")).toBe(true);
    });

    test("returns false for unsupported models", () => {
      expect(supportsEffort("claude-haiku-4.5")).toBe(false);
      expect(supportsEffort("unknown-model")).toBe(false);
    });
  });

  describe("supportsXHighEffort", () => {
    test("returns true for Fable 5.1, Opus 4.7, 4.8, and 5", () => {
      expect(supportsXHighEffort("claude-fable-5.1")).toBe(true);
      expect(supportsXHighEffort("claude-opus-5")).toBe(true);
      expect(supportsXHighEffort("claude-opus-4.8")).toBe(true);
      expect(supportsXHighEffort("claude-opus-4.7")).toBe(true);
    });

    test("returns false for other models", () => {
      expect(supportsXHighEffort("claude-opus-4.6")).toBe(false);
      expect(supportsXHighEffort("claude-sonnet-4.6")).toBe(false);
    });
  });

  describe("2026-11-26 Claude additions", () => {
    const additions = ["claude-fable-5.2", "claude-sonnet-5.5", "claude-haiku-5.5"];

    test("expose the full five-level enum their schemas declare", () => {
      for (const model of additions) {
        expect(supportsEffort(model)).toBe(true);
        expect(supportsXHighEffort(model)).toBe(true);
        expect(getSupportedEffortLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
        expect(resolveEffort(model, "xhigh")).toBe("xhigh");
      }
    });

    test("advertise the schema defaults instead of a uniform medium", () => {
      expect(getDefaultEffort("claude-fable-5.2")).toBe("high");
      expect(getDefaultEffort("claude-sonnet-5.5")).toBe("high");
      expect(getDefaultEffort("claude-haiku-5.5")).toBe("medium");
      expect(getDefaultEffort("claude-opus-5.5")).toBe("medium");
      expect(getDefaultEffort("kimi-k3")).toBe("max");
      expect(getDefaultEffort("claude-haiku-4.5")).toBeUndefined();
    });

    test("send adaptive display controls without joining the operator recovery set", () => {
      for (const model of additions) {
        expect(supportsAdaptiveThinkingDisplay(model)).toBe(true);
        expect(supportsForcedOmittedThinkingDisplay(model)).toBe(false);
        expect(buildThinkingRequestFields(model, true)).toEqual({
          thinking: { type: "adaptive", display: "omitted" },
        });
        expect(buildThinkingRequestFields(model, true, "summarized")).toEqual({
          thinking: { type: "adaptive", display: "summarized" },
        });
        expect(buildThinkingRequestFields(model, false)).toBeUndefined();
      }
      for (const model of ["claude-fable-5.1", "claude-opus-5.5"]) {
        expect(supportsForcedOmittedThinkingDisplay(model)).toBe(true);
      }
      expect(supportsAdaptiveThinkingDisplay("claude-opus-5")).toBe(false);
    });

    test("project an explicit disable only where the schema declares that type", () => {
      expect(buildThinkingDisabledRequestFields("claude-haiku-5.5")).toEqual({
        thinking: { type: "disabled" },
      });
      for (const model of ["claude-fable-5.2", "claude-sonnet-5.5", "claude-opus-5.5", "kimi-k3"]) {
        expect(buildThinkingDisabledRequestFields(model)).toBeUndefined();
      }
    });
  });

  describe("resolveEffort", () => {
    test("returns undefined for unsupported models", () => {
      expect(resolveEffort("claude-haiku-4.5", "max")).toBeUndefined();
    });

    test("returns effort as-is for supported levels", () => {
      expect(resolveEffort("claude-opus-5", "xhigh")).toBe("xhigh");
      expect(resolveEffort("claude-opus-4.8", "low")).toBe("low");
      expect(resolveEffort("claude-opus-4.8", "max")).toBe("max");
      expect(resolveEffort("claude-opus-4.8", "xhigh")).toBe("xhigh");
    });

    test("clamps xhigh to max for models without xhigh support", () => {
      expect(resolveEffort("claude-sonnet-4.6", "xhigh")).toBe("max");
      expect(resolveEffort("claude-opus-4.6", "xhigh")).toBe("max");
    });
  });

  describe("budgetToEffort", () => {
    test("returns undefined for unsupported models", () => {
      expect(budgetToEffort(100000, "claude-haiku-4.5")).toBeUndefined();
    });

    test("maps budget ranges correctly", () => {
      expect(budgetToEffort(5000, "claude-opus-4.8")).toBe("low");
      expect(budgetToEffort(16384, "claude-opus-4.8")).toBe("medium");
      expect(budgetToEffort(24576, "claude-opus-4.8")).toBe("high");
      expect(budgetToEffort(32768, "claude-opus-4.8")).toBe("max");
      expect(budgetToEffort(80000, "claude-opus-4.8")).toBe("max");
    });

    test("maps to max instead of xhigh for non-xhigh models", () => {
      expect(budgetToEffort(80000, "claude-sonnet-4.6")).toBe("max");
    });
  });

  describe("getEffectiveEffort", () => {
    test("returns undefined for unsupported models", () => {
      expect(getEffectiveEffort("claude-haiku-4.5", true, 100000)).toBeUndefined();
    });

    test("uses explicit config when provided", () => {
      expect(getEffectiveEffort("claude-opus-4.8", true, 20000, "max")).toBe("max");
      expect(getEffectiveEffort("claude-opus-4.8", false, 20000, "high")).toBe("high");
    });

    test("returns undefined when not thinking and no config", () => {
      expect(getEffectiveEffort("claude-opus-4.8", false, 20000)).toBeUndefined();
    });

    test("uses budget mapping when thinking and auto-mapping enabled", () => {
      expect(getEffectiveEffort("claude-opus-4.8", true, 128000, undefined, true)).toBe("max");
      expect(getEffectiveEffort("claude-opus-4.8", true, 20000, undefined, true)).toBe("medium");
    });

    test("falls back to medium when auto-mapping disabled", () => {
      expect(getEffectiveEffort("claude-opus-4.8", true, 128000, undefined, false)).toBe("medium");
    });
  });
});
