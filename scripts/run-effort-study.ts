/**
 * Sequential runner for the 72-cell plan emitted by effort-study.ts.
 *
 * The runner delegates each cell to Zuno's existing run_eval.py harness and
 * never edits the Zuno repository. Live execution requires --confirm.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EffortStudyCell, EffortStudyPlan } from "./effort-study.js";

interface Options {
  readonly planPath: string;
  readonly harnessRoot: string;
  readonly zunoBin: string;
  readonly configRoot: string;
  readonly authFile: string;
  readonly accountsDb: string;
  readonly logFile: string;
  readonly outputRoot: string;
  readonly workRoot: string;
  readonly maxCases?: number;
  readonly resume: boolean;
  readonly continueOnError: boolean;
  readonly confirm: boolean;
  readonly dry: boolean;
}

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function parseOptions(): Options {
  const required = (name: string): string => {
    const value = argument(name);
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const maxCasesRaw = argument("--max-cases");
  const maxCases = maxCasesRaw === undefined ? undefined : Number(maxCasesRaw);
  if (maxCases !== undefined && (!Number.isInteger(maxCases) || maxCases < 1)) {
    throw new Error("--max-cases must be a positive integer");
  }
  return {
    planPath: required("--plan"),
    harnessRoot: required("--harness-root"),
    zunoBin: required("--zuno-bin"),
    configRoot: required("--config-root"),
    authFile: required("--auth-file"),
    accountsDb: required("--accounts-db"),
    logFile: required("--log-file"),
    outputRoot: required("--output-root"),
    workRoot: required("--work-root"),
    ...(maxCases === undefined ? {} : { maxCases }),
    resume: process.argv.includes("--resume"),
    continueOnError: process.argv.includes("--continue-on-error"),
    confirm: process.argv.includes("--confirm"),
    dry: process.argv.includes("--dry"),
  };
}

function readPlan(path: string): EffortStudyPlan {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("schema_version" in value) ||
    value.schema_version !== 1 ||
    !("cells" in value) ||
    !Array.isArray(value.cells)
  ) {
    throw new TypeError("invalid effort-study plan");
  }
  return value as unknown as EffortStudyPlan;
}

export function runId(cell: EffortStudyCell): string {
  return `effort-study-r${cell.repetition}-${cell.agent}-${cell.scenario}-${cell.model}-${cell.effort}`;
}

export function commandForCell(cell: EffortStudyCell, options: Options): string[] {
  const id = runId(cell);
  return [
    "python3",
    join(options.harnessRoot, "run_eval.py"),
    "--adapter",
    "zuno",
    "--agent",
    cell.agent,
    "--scenario",
    cell.scenario,
    "--sandbox",
    "workspace-write",
    "--effort",
    cell.effort,
    "--iteration",
    String(cell.repetition),
    "--run-id",
    id,
    "--timeout-seconds",
    "1200",
    "--output-root",
    options.outputRoot,
    "--work-root",
    options.workRoot,
    "--zuno-bin",
    options.zunoBin,
    "--zuno-config",
    join(options.configRoot, `kiro-local-${cell.model}-${cell.effort}`, "zuno.json"),
    "--zuno-model",
    `kiro-local/${cell.model}`,
    "--zuno-auth-file",
    options.authFile,
    "--kiro-accounts-db",
    options.accountsDb,
    "--kiro-log-file",
    options.logFile,
  ];
}

async function main(): Promise<void> {
  const options = parseOptions();
  const plan = readPlan(options.planPath);
  const pending = plan.cells
    .filter(
      (cell) => !options.resume || !existsSync(join(options.outputRoot, runId(cell), "meta.json")),
    )
    .slice(0, options.maxCases);
  console.log(`effort study pending cells: ${pending.length}`);
  if (options.dry) {
    for (const cell of pending) console.log(JSON.stringify(commandForCell(cell, options)));
    return;
  }
  if (!options.confirm) {
    throw new Error("live effort study requires --confirm");
  }
  let failed = 0;
  for (const [index, cell] of pending.entries()) {
    const id = runId(cell);
    console.log(`[${index + 1}/${pending.length}] ${id}`);
    const child = Bun.spawn(commandForCell(cell, options), {
      cwd: dirnameOfHarness(options.harnessRoot),
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode === 0) continue;
    failed += 1;
    if (!options.continueOnError) {
      throw new Error(`${id} failed with exit code ${exitCode}`);
    }
  }
  if (failed > 0) process.exitCode = 1;
}

function dirnameOfHarness(harnessRoot: string): string {
  const suffix = "/experiments/agent-eval";
  return harnessRoot.endsWith(suffix) ? harnessRoot.slice(0, -suffix.length) : harnessRoot;
}

if (import.meta.main) await main();
