import { describe, expect, test } from "bun:test";
import { buildEffortStudyPlan } from "../scripts/effort-study.js";
import { commandForCell, runId } from "../scripts/run-effort-study.js";

describe("effort study runner", () => {
  test("maps a plan cell to one isolated run_eval invocation", () => {
    const cell = buildEffortStudyPlan().cells[0];
    if (!cell) throw new TypeError("missing plan cell");
    const options = {
      planPath: "/tmp/plan.json",
      harnessRoot: "/repo/experiments/agent-eval",
      zunoBin: "/repo/target/release/zuno",
      configRoot: "/tmp/configs",
      authFile: "/tmp/auth.json",
      accountsDb: "/tmp/accounts.db",
      logFile: "/tmp/provider.log",
      outputRoot: "/tmp/results",
      workRoot: "/tmp/work",
      resume: true,
      continueOnError: true,
      confirm: false,
      dry: true,
    };

    expect(runId(cell)).toBe("effort-study-r1-build-implementation-gpt-5.6-sol-max");
    expect(commandForCell(cell, options)).toContain(
      "/tmp/configs/kiro-local-gpt-5.6-sol-max/zuno.json",
    );
    expect(commandForCell(cell, options)).toContain("kiro-local/gpt-5.6-sol");
  });
});
