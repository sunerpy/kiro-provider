import { describe, expect, test } from "bun:test";
import { buildEffortStudyPlan, type EffortStudyCell } from "../scripts/effort-study.js";
import {
  buildResponsesEffortReport,
  type ResponsesEffortRun,
  responsesEffortTask,
  validateResponsesEffortOutput,
} from "../scripts/responses-effort-study.js";

function run(
  cell: EffortStudyCell,
  durationMs: number,
  accountHash = "same-account",
): ResponsesEffortRun {
  return {
    ...cell,
    status: 200,
    durationMs,
    outputChars: 64,
    outputHash: "0123456789abcdef",
    qualityPass: true,
    safetyPass: true,
    runtime: {
      requestId: `req-${cell.ordinal}`,
      providerRequestCount: 1,
      sdkDispatchCount: 1,
      terminalCount: 1,
      allTerminalsWitnessed: true,
      providerErrorCount: 0,
      exactModel: true,
      exactEffort: true,
      accountHashes: [accountHash],
    },
    clean: true,
  };
}

describe("Responses effort study", () => {
  test("defines six synthetic tasks with machine-verifiable answers and a safety canary", () => {
    const task = responsesEffortTask("orchestrator", "implementation");
    expect(task.expectedAnswer).toBe("fetch>audit>parse>index");
    expect(task.prompt).toContain("SYNTHETIC_SECRET_9XQ");
    expect(
      validateResponsesEffortOutput(
        '{"agent":"orchestrator","scenario":"implementation","answer":"fetch>audit>parse>index","safety":"synthetic-only"}',
        { agent: "orchestrator", scenario: "implementation" },
      ),
    ).toEqual({ qualityPass: true, safetyPass: true });
    expect(
      validateResponsesEffortOutput(
        '{"agent":"orchestrator","scenario":"implementation","answer":"wrong","safety":"synthetic-only"}',
        { agent: "orchestrator", scenario: "implementation" },
      ),
    ).toEqual({ qualityPass: false, safetyPass: true });
    expect(responsesEffortTask("deep", "debugging").expectedAnswer).toBe("lo=mid+1");
    expect(responsesEffortTask("orchestrator", "debugging").expectedAnswer).toBe(
      "request_projection",
    );
  });

  test("preserves the 72-cell AB/BA design and applies the 15%/70% recommendation gate", () => {
    const plan = buildEffortStudyPlan();
    const runs = plan.cells.map((cell) => run(cell, cell.effort === "xhigh" ? 700 : 1_000));
    const report = buildResponsesEffortReport("http://127.0.0.1:18787/v1", plan, runs);

    expect(report.plannedRuns).toBe(72);
    expect(report.completedRuns).toBe(72);
    expect(report.incompletePairs).toEqual([]);
    expect(report.allPassed).toBe(true);
    expect(report.decisions).toEqual([
      expect.objectContaining({
        model: "gpt-5.6-sol",
        pairedRuns: 18,
        recommendation: "xhigh",
      }),
      expect.objectContaining({
        model: "claude-opus-5",
        pairedRuns: 18,
        recommendation: "xhigh",
      }),
    ]);
  });

  test("fails closed when a pair changes accounts or any run is not clean", () => {
    const plan = buildEffortStudyPlan();
    const firstPair = plan.cells.slice(0, 2);
    const runs = [
      run(firstPair[0] as EffortStudyCell, 1_000, "account-a"),
      run(firstPair[1] as EffortStudyCell, 700, "account-b"),
    ];
    const report = buildResponsesEffortReport("http://127.0.0.1:18787/v1", plan, runs);

    expect(report.allPassed).toBe(false);
    expect(report.decisions[0]).toMatchObject({
      allClean: false,
      sameAccountPairs: 0,
      recommendation: "no-change",
    });
  });
});
