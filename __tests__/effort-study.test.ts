import { describe, expect, test } from "bun:test";
import {
  analyzeEffortStudyRuns,
  buildEffortStudyPlan,
  correlateRuntimeEvents,
  type EffortStudyRun,
  eventsInRunWindow,
} from "../scripts/effort-study.js";

function run(
  effort: "max" | "xhigh",
  durationSeconds: number,
  sdkDispatchCount: number,
): EffortStudyRun {
  return {
    runId: `run-${effort}`,
    pairId: "gpt-5.6-sol-build-debugging-r1",
    model: "gpt-5.6-sol",
    agent: "build",
    scenario: "debugging",
    repetition: 1,
    effort,
    durationSeconds,
    score: 100,
    exitCode: 0,
    graderExitCode: 0,
    timedOut: false,
    runtime: {
      providerRequestCount: 2,
      sdkDispatchCount,
      terminalCount: sdkDispatchCount,
      allTerminalsWitnessed: true,
      providerErrorCount: 0,
      efforts: [effort],
      accountHashes: ["account-a"],
    },
    exactEffort: true,
    clean: true,
  };
}

describe("effort study plan", () => {
  test("generates the fixed 72-cell single-worker AB/BA matrix", () => {
    const plan = buildEffortStudyPlan();

    expect(plan.cells).toHaveLength(72);
    expect(new Set(plan.cells.map((cell) => cell.pair_id))).toHaveLength(36);
    expect(plan.cells.every((cell) => cell.worker_count === 1)).toBe(true);
    for (let index = 0; index < plan.cells.length; index += 2) {
      const pair = plan.cells.slice(index, index + 2);
      expect(new Set(pair.map((cell) => cell.effort))).toEqual(new Set(["max", "xhigh"]));
      expect(pair[0]?.pair_id).toBe(pair[1]?.pair_id);
    }
  });
});

describe("effort study analysis", () => {
  test("bounds a shared provider log to the run window before correlation", () => {
    const events = eventsInRunWindow(
      [
        { timestamp: "2026-09-05T14:00:00.000Z", event: "before" },
        { timestamp: "2026-09-05T14:00:09.000Z", event: "inside" },
        { timestamp: "2026-09-05T14:00:41.000Z", event: "after" },
      ],
      "20260905T140010Z",
      10,
    );

    expect(events.map((event) => event.event)).toEqual(["before", "inside"]);
  });

  test("keeps pre-conversation stages through request_id after exact conversation correlation", () => {
    const events = correlateRuntimeEvents(
      [
        {
          event: "request_shape",
          request_id: "req-match",
        },
        {
          event: "sdk_dispatch_started",
          request_id: "req-match",
          conversation_hash: "conversation-match",
        },
        {
          event: "sdk_dispatch_started",
          request_id: "req-other",
          conversation_hash: "conversation-other",
        },
      ],
      "conversation-match",
    );

    expect(events.map((event) => event.event)).toEqual(["request_shape", "sdk_dispatch_started"]);
  });

  test("recommends xhigh only when the quality and controlled efficiency gates pass", () => {
    const pairs: EffortStudyRun[] = [];
    for (let index = 0; index < 10; index += 1) {
      const max = {
        ...run("max", 100, 10),
        runId: `max-${index}`,
        pairId: `gpt-5.6-sol-build-debugging-r${index}`,
        repetition: index,
      };
      const xhigh = {
        ...run("xhigh", 70, 7),
        runId: `xhigh-${index}`,
        pairId: max.pairId,
        repetition: index,
      };
      pairs.push(max, xhigh);
    }

    const analysis = analyzeEffortStudyRuns(pairs);
    expect(analysis.decisions.find((decision) => decision.model === "gpt-5.6-sol")).toMatchObject({
      allClean: true,
      recommendation: "xhigh",
      xhighWallWinRate: 1,
      xhighDispatchWinRate: 1,
    });
  });

  test("keeps no-change when a quality gate fails", () => {
    const max = run("max", 100, 10);
    const xhigh = { ...run("xhigh", 60, 6), clean: false, score: 90 };
    const analysis = analyzeEffortStudyRuns([max, xhigh]);

    expect(analysis.decisions.find((decision) => decision.model === "gpt-5.6-sol")).toMatchObject({
      allClean: false,
      recommendation: "no-change",
    });
  });
});
