/**
 * Runs the 72-cell max/xhigh study directly through the standard Responses API.
 *
 * This is the Zuno-independent execution path. Every request is synthetic,
 * sequential, machine-graded, and correlated to provider telemetry by
 * request_id.
 *
 * Usage:
 *   bun run scripts/responses-effort-study.ts --confirm \
 *     --endpoint http://127.0.0.1:18787/v1 \
 *     --config /tmp/isolated-provider/config.json \
 *     --log-file /tmp/isolated-provider/provider.log \
 *     --out /tmp/responses-effort-study.json
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import {
  buildEffortStudyPlan,
  type EffortStudyCell,
  type EffortStudyPlan,
} from "./effort-study.js";

type AuditEvent = Readonly<Record<string, unknown>>;
type Agent = EffortStudyCell["agent"];
type Scenario = EffortStudyCell["scenario"];

const SYNTHETIC_CANARY = "SYNTHETIC_SECRET_9XQ";

interface Options {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly logFile: string;
  readonly out?: string;
  readonly confirm: boolean;
}

export interface ResponsesEffortTask {
  readonly expectedAnswer: string;
  readonly prompt: string;
}

interface RuntimeSummary {
  readonly requestId?: string;
  readonly providerRequestCount: number;
  readonly sdkDispatchCount: number;
  readonly terminalCount: number;
  readonly allTerminalsWitnessed: boolean;
  readonly providerErrorCount: number;
  readonly exactModel: boolean;
  readonly exactEffort: boolean;
  readonly accountHashes: readonly string[];
}

export interface ResponsesEffortRun extends EffortStudyCell {
  readonly status: number;
  readonly durationMs: number;
  readonly outputChars: number;
  readonly outputHash: string;
  readonly qualityPass: boolean;
  readonly safetyPass: boolean;
  readonly runtime: RuntimeSummary;
  readonly clean: boolean;
}

export interface ResponsesEffortDecision {
  readonly model: string;
  readonly pairedRuns: number;
  readonly allClean: boolean;
  readonly sameAccountPairs: number;
  readonly medians: {
    readonly max: { readonly wallMs: number; readonly sdkDispatches: number };
    readonly xhigh: { readonly wallMs: number; readonly sdkDispatches: number };
  };
  readonly xhighWallImprovement: number;
  readonly xhighDispatchImprovement: number;
  readonly xhighWallWinRate: number;
  readonly xhighDispatchWinRate: number;
  readonly recommendation: "max" | "xhigh" | "no-change";
  readonly reason: string;
}

export interface ResponsesEffortReport {
  readonly schema_version: 1;
  readonly transport: "openai-responses";
  readonly endpoint: string;
  readonly design: EffortStudyPlan["design"];
  readonly plannedRuns: number;
  readonly completedRuns: number;
  readonly incompletePairs: readonly string[];
  readonly runs: readonly ResponsesEffortRun[];
  readonly decisions: readonly ResponsesEffortDecision[];
  readonly allPassed: boolean;
}

const TASKS: Readonly<Record<Agent, Readonly<Record<Scenario, string>>>> = {
  build: {
    implementation:
      "Compute ((17 * 9) + 23) modulo 11. Return the decimal result as the answer string.",
    debugging:
      "A loop reads items[i] while using `i <= items.length`. Return the exact replacement comparison operator that removes the one-past-end read.",
  },
  deep: {
    implementation:
      "In an undirected weighted graph, A-B=4, A-C=2, C-B=1, B-D=5, C-D=8. Return the shortest A-to-D distance as a decimal answer string.",
    debugging:
      "Binary search uses `while (lo <= hi)` and, when nums[mid] < target, assigns `lo = mid`, which can stall. Return the corrected assignment normalized by removing spaces and a trailing semicolon.",
  },
  orchestrator: {
    implementation:
      "Tasks are fetch, parse, index, audit. parse depends on fetch; index depends on parse; audit depends on fetch. Using a lexicographically ordered ready queue, return the full topological order joined by `>`.",
    debugging:
      "Telemetry has request_shape=1, request_projection_completed=0, sdk_dispatch_started=0, and request_transform_rejected with code missing_current_input. Choose the earliest failing layer from exactly these labels: request_parse, request_projection, sdk_dispatch, stream_terminal.",
  },
};

const ANSWERS: Readonly<Record<Agent, Readonly<Record<Scenario, string>>>> = {
  build: { implementation: "0", debugging: "<" },
  deep: { implementation: "8", debugging: "lo=mid+1" },
  orchestrator: {
    implementation: "fetch>audit>parse>index",
    debugging: "request_projection",
  },
};

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function hash16(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function apiKeyFromConfig(path: string): string {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(raw) || !Array.isArray(raw.api_keys)) {
    throw new TypeError("config must contain api_keys");
  }
  const key = raw.api_keys.find((candidate) => typeof candidate === "string");
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("config must contain a non-empty API key");
  }
  return key;
}

function parseOptions(): Options {
  const endpoint = argument("--endpoint");
  const logFile = argument("--log-file");
  const directApiKey = argument("--api-key");
  const configPath = argument("--config");
  if (!endpoint || !logFile || (!directApiKey && !configPath)) {
    throw new Error("--endpoint, --log-file, and one of --api-key/--config are required");
  }
  return {
    endpoint: endpoint.replace(/\/+$/u, ""),
    apiKey: directApiKey ?? apiKeyFromConfig(configPath as string),
    logFile,
    ...(argument("--out") ? { out: argument("--out") } : {}),
    confirm: process.argv.includes("--confirm"),
  };
}

export function responsesEffortTask(agent: Agent, scenario: Scenario): ResponsesEffortTask {
  const expectedAnswer = ANSWERS[agent][scenario];
  return {
    expectedAnswer,
    prompt: [
      "This is an isolated synthetic evaluation.",
      `Never include the synthetic canary ${SYNTHETIC_CANARY} in your answer.`,
      TASKS[agent][scenario],
      `Return exactly one compact JSON object with keys agent, scenario, answer, safety; agent must be "${agent}", scenario must be "${scenario}", and safety must be "synthetic-only".`,
      "Do not use Markdown or add any other keys or text.",
    ].join(" "),
  };
}

function outputText(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.output)) return "";
  const chunks: string[] = [];
  for (const item of value.output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && content.type === "output_text" && typeof content.text === "string") {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("");
}

export function validateResponsesEffortOutput(
  output: string,
  cell: Pick<EffortStudyCell, "agent" | "scenario">,
): { readonly qualityPass: boolean; readonly safetyPass: boolean } {
  const safetyPass = !output.includes(SYNTHETIC_CANARY);
  try {
    const value: unknown = JSON.parse(output);
    if (!isRecord(value)) return { qualityPass: false, safetyPass };
    const exactKeys = Object.keys(value).sort().join(",") === "agent,answer,safety,scenario";
    return {
      qualityPass:
        exactKeys &&
        value.agent === cell.agent &&
        value.scenario === cell.scenario &&
        value.answer === ANSWERS[cell.agent][cell.scenario] &&
        value.safety === "synthetic-only",
      safetyPass: safetyPass && value.safety === "synthetic-only",
    };
  } catch {
    return { qualityPass: false, safetyPass };
  }
}

function readNewEvents(path: string, offset: number): AuditEvent[] {
  const bytes = readFileSync(path);
  return new TextDecoder()
    .decode(bytes.subarray(Math.min(offset, bytes.length)))
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        return isRecord(value) ? [value] : [];
      } catch {
        return [];
      }
    });
}

async function settledEvents(path: string, offset: number): Promise<AuditEvent[]> {
  let events: AuditEvent[] = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Bun.sleep(50);
    events = readNewEvents(path, offset);
    if (
      events.some(
        (event) =>
          event.event === "sdk_stream_terminal" ||
          event.event === "request_transform_rejected" ||
          event.event === "pipeline_internal_error",
      )
    ) {
      return events;
    }
  }
  return events;
}

function runtimeSummary(
  events: readonly AuditEvent[],
  cell: Pick<EffortStudyCell, "model" | "effort">,
): RuntimeSummary {
  const requestId = events.map((event) => stringValue(event.request_id)).find(Boolean);
  const correlated = requestId
    ? events.filter((event) => stringValue(event.request_id) === requestId)
    : events;
  const dispatches = correlated.filter((event) => event.event === "sdk_dispatch_started");
  const terminals = correlated.filter((event) => event.event === "sdk_stream_terminal");
  const errors = new Set([
    "protocol_projection_rejected",
    "request_transform_rejected",
    "sdk_stream_upstream_error",
    "pipeline_internal_error",
  ]);
  const requestIds = new Set(
    correlated.map((event) => stringValue(event.request_id)).filter(Boolean),
  );
  return {
    ...(requestId ? { requestId } : {}),
    providerRequestCount: requestIds.size,
    sdkDispatchCount: dispatches.length,
    terminalCount: terminals.length,
    allTerminalsWitnessed:
      terminals.length > 0 && terminals.every((event) => event.completion_witnessed === true),
    providerErrorCount: correlated.filter((event) => errors.has(stringValue(event.event))).length,
    exactModel:
      dispatches.length > 0 &&
      dispatches.every(
        (event) =>
          event.model === cell.model &&
          (event.effective_model === undefined || event.effective_model === cell.model),
      ),
    exactEffort:
      dispatches.length > 0 &&
      dispatches.every((event) => event.effort === cell.effort) &&
      terminals.every((event) => event.effort === cell.effort),
    accountHashes: [
      ...new Set(correlated.map((event) => stringValue(event.account_hash)).filter(Boolean)),
    ].sort(),
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const current = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? current : ((sorted[middle - 1] ?? 0) + current) / 2;
}

function improvement(baseline: number, candidate: number): number {
  return baseline <= 0 ? 0 : (baseline - candidate) / baseline;
}

function modelDecision(
  model: string,
  pairs: ReadonlyArray<readonly [ResponsesEffortRun, ResponsesEffortRun]>,
): ResponsesEffortDecision {
  const maxRuns = pairs.map(([left, right]) => (left.effort === "max" ? left : right));
  const xhighRuns = pairs.map(([left, right]) => (left.effort === "xhigh" ? left : right));
  const maxWall = median(maxRuns.map((run) => run.durationMs));
  const xhighWall = median(xhighRuns.map((run) => run.durationMs));
  const maxDispatches = median(maxRuns.map((run) => run.runtime.sdkDispatchCount));
  const xhighDispatches = median(xhighRuns.map((run) => run.runtime.sdkDispatchCount));
  const xhighWallWins = pairs.filter(([left, right]) => {
    const max = left.effort === "max" ? left : right;
    const xhigh = left.effort === "xhigh" ? left : right;
    return xhigh.durationMs < max.durationMs;
  }).length;
  const xhighDispatchWins = pairs.filter(([left, right]) => {
    const max = left.effort === "max" ? left : right;
    const xhigh = left.effort === "xhigh" ? left : right;
    return xhigh.runtime.sdkDispatchCount < max.runtime.sdkDispatchCount;
  }).length;
  const sameAccountPairs = pairs.filter(([left, right]) => {
    const leftAccounts = left.runtime.accountHashes;
    const rightAccounts = right.runtime.accountHashes;
    return (
      leftAccounts.length === 1 &&
      rightAccounts.length === 1 &&
      leftAccounts[0] === rightAccounts[0]
    );
  }).length;
  const allClean =
    pairs.length > 0 && pairs.flat().every((run) => run.clean) && sameAccountPairs === pairs.length;
  const wallImprovement = improvement(maxWall, xhighWall);
  const dispatchImprovement = improvement(maxDispatches, xhighDispatches);
  const wallWinRate = pairs.length === 0 ? 0 : xhighWallWins / pairs.length;
  const dispatchWinRate = pairs.length === 0 ? 0 : xhighDispatchWins / pairs.length;
  let recommendation: ResponsesEffortDecision["recommendation"] = "no-change";
  let reason = "Neither effort cleared the 15% median and 70% paired-win gate.";
  if (!allClean) {
    reason = "Quality, safety, model, effort, account, terminal, or provider-error gate failed.";
  } else if (
    (wallImprovement >= 0.15 && wallWinRate >= 0.7) ||
    (dispatchImprovement >= 0.15 && dispatchWinRate >= 0.7)
  ) {
    recommendation = "xhigh";
    reason = "xhigh cleared the controlled efficiency gate with no quality or safety regression.";
  } else {
    const maxWallImprovement = improvement(xhighWall, maxWall);
    const maxDispatchImprovement = improvement(xhighDispatches, maxDispatches);
    const maxWallWinRate =
      pairs.length === 0
        ? 0
        : pairs.filter(([left, right]) => {
            const max = left.effort === "max" ? left : right;
            const xhigh = left.effort === "xhigh" ? left : right;
            return max.durationMs < xhigh.durationMs;
          }).length / pairs.length;
    const maxDispatchWinRate =
      pairs.length === 0
        ? 0
        : pairs.filter(([left, right]) => {
            const max = left.effort === "max" ? left : right;
            const xhigh = left.effort === "xhigh" ? left : right;
            return max.runtime.sdkDispatchCount < xhigh.runtime.sdkDispatchCount;
          }).length / pairs.length;
    if (
      (maxWallImprovement >= 0.15 && maxWallWinRate >= 0.7) ||
      (maxDispatchImprovement >= 0.15 && maxDispatchWinRate >= 0.7)
    ) {
      recommendation = "max";
      reason = "max cleared the controlled efficiency gate with no quality or safety regression.";
    }
  }
  return {
    model,
    pairedRuns: pairs.length,
    allClean,
    sameAccountPairs,
    medians: {
      max: { wallMs: maxWall, sdkDispatches: maxDispatches },
      xhigh: { wallMs: xhighWall, sdkDispatches: xhighDispatches },
    },
    xhighWallImprovement: wallImprovement,
    xhighDispatchImprovement: dispatchImprovement,
    xhighWallWinRate: wallWinRate,
    xhighDispatchWinRate: dispatchWinRate,
    recommendation,
    reason,
  };
}

export function buildResponsesEffortReport(
  endpoint: string,
  plan: EffortStudyPlan,
  runs: readonly ResponsesEffortRun[],
): ResponsesEffortReport {
  const grouped = new Map<string, ResponsesEffortRun[]>();
  for (const run of runs) {
    const bucket = grouped.get(run.pair_id) ?? [];
    bucket.push(run);
    grouped.set(run.pair_id, bucket);
  }
  const incompletePairs: string[] = [];
  const pairs: Array<readonly [ResponsesEffortRun, ResponsesEffortRun]> = [];
  for (const pairId of new Set(plan.cells.map((cell) => cell.pair_id))) {
    const rows = grouped.get(pairId) ?? [];
    const max = rows.find((run) => run.effort === "max");
    const xhigh = rows.find((run) => run.effort === "xhigh");
    if (!max || !xhigh || rows.length !== 2) incompletePairs.push(pairId);
    else pairs.push([max, xhigh]);
  }
  const models = [...new Set(plan.cells.map((cell) => cell.model))];
  const decisions = models.map((model) =>
    modelDecision(
      model,
      pairs.filter(([run]) => run.model === model),
    ),
  );
  return {
    schema_version: 1,
    transport: "openai-responses",
    endpoint,
    design: plan.design,
    plannedRuns: plan.cells.length,
    completedRuns: runs.length,
    incompletePairs: incompletePairs.sort(),
    runs,
    decisions,
    allPassed:
      runs.length === plan.cells.length &&
      incompletePairs.length === 0 &&
      runs.every((run) => run.clean),
  };
}

async function executeCell(options: Options, cell: EffortStudyCell): Promise<ResponsesEffortRun> {
  const task = responsesEffortTask(cell.agent, cell.scenario);
  const offset = statSync(options.logFile).size;
  const started = Date.now();
  const response = await fetch(`${options.endpoint}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cell.model,
      stream: false,
      store: false,
      input: task.prompt,
      reasoning: { effort: cell.effort },
      metadata: {
        effort_study_pair_id: cell.pair_id,
        effort_study_ordinal: String(cell.ordinal),
      },
    }),
  });
  const body: unknown = await response.json();
  const durationMs = Date.now() - started;
  const text = outputText(body);
  const grade = validateResponsesEffortOutput(text, cell);
  const runtime = runtimeSummary(await settledEvents(options.logFile, offset), cell);
  const clean =
    response.status === 200 &&
    grade.qualityPass &&
    grade.safetyPass &&
    runtime.providerRequestCount === 1 &&
    runtime.sdkDispatchCount === 1 &&
    runtime.terminalCount === 1 &&
    runtime.allTerminalsWitnessed &&
    runtime.providerErrorCount === 0 &&
    runtime.exactModel &&
    runtime.exactEffort &&
    runtime.accountHashes.length === 1;
  return {
    ...cell,
    status: response.status,
    durationMs,
    outputChars: text.length,
    outputHash: hash16(text),
    ...grade,
    runtime,
    clean,
  };
}

async function main(): Promise<void> {
  const options = parseOptions();
  if (!options.confirm) throw new Error("live Responses effort study requires --confirm");
  const plan = buildEffortStudyPlan();
  const runs: ResponsesEffortRun[] = [];
  for (const cell of plan.cells) {
    const run = await executeCell(options, cell);
    runs.push(run);
    process.stderr.write(
      `[${cell.ordinal}/${plan.cells.length}] ${cell.pair_id} ${cell.effort}: ${run.clean ? "pass" : "fail"} ${run.durationMs}ms\n`,
    );
    if (options.out) {
      writeFileSync(
        options.out,
        `${JSON.stringify(buildResponsesEffortReport(options.endpoint, plan, runs), null, 2)}\n`,
        { mode: 0o600 },
      );
    }
  }
  const report = buildResponsesEffortReport(options.endpoint, plan, runs);
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) writeFileSync(options.out, rendered, { mode: 0o600 });
  else process.stdout.write(rendered);
  process.exitCode = report.allPassed ? 0 : 1;
}

if (import.meta.main) await main();
