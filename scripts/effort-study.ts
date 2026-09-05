/**
 * Generates and analyzes the controlled Kiro max/xhigh study.
 *
 * Plan:
 *   bun run scripts/effort-study.ts plan [--out /tmp/kiro-effort-plan.json]
 *
 * Analyze completed Zuno result bundles:
 *   bun run scripts/effort-study.ts analyze \
 *     --results /tmp/kiro-effort-results \
 *     [--out /tmp/kiro-effort-analysis.json]
 *
 * Each bundle must contain meta.json and kiro-provider-events.jsonl. Provider
 * request and retry counts are derived directly from request_id and
 * sdk_dispatch_started events, never from Agent step counts.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const MODELS = ["gpt-5.6-sol", "claude-opus-5"] as const;
const AGENTS = ["build", "deep", "orchestrator"] as const;
const SCENARIOS = ["implementation", "debugging"] as const;
const EFFORTS = ["max", "xhigh"] as const;
const REPETITIONS = 3;

type Model = (typeof MODELS)[number];
type Agent = (typeof AGENTS)[number];
type Scenario = (typeof SCENARIOS)[number];
type Effort = (typeof EFFORTS)[number];

export interface EffortStudyCell {
  readonly ordinal: number;
  readonly pair_id: string;
  readonly provider: "kiro-local";
  readonly model: Model;
  readonly agent: Agent;
  readonly scenario: Scenario;
  readonly repetition: number;
  readonly effort: Effort;
  readonly order_in_pair: 1 | 2;
  readonly worker_count: 1;
}

export interface EffortStudyPlan {
  readonly schema_version: 1;
  readonly design: "paired-ab-ba";
  readonly cells: readonly EffortStudyCell[];
}

interface RuntimeMetrics {
  readonly providerRequestCount: number;
  readonly sdkDispatchCount: number;
  readonly terminalCount: number;
  readonly allTerminalsWitnessed: boolean;
  readonly providerErrorCount: number;
  readonly efforts: readonly string[];
  readonly accountHashes: readonly string[];
}

export interface EffortStudyRun {
  readonly runId: string;
  readonly pairId: string;
  readonly model: string;
  readonly agent: string;
  readonly scenario: string;
  readonly repetition: number;
  readonly effort: string;
  readonly durationSeconds: number;
  readonly score: number;
  readonly exitCode: number;
  readonly graderExitCode: number;
  readonly timedOut: boolean;
  readonly runtime: RuntimeMetrics;
  readonly exactEffort: boolean;
  readonly clean: boolean;
}

interface ModelDecision {
  readonly model: string;
  readonly pairedRuns: number;
  readonly allClean: boolean;
  readonly sameAccountPairs: number;
  readonly medians: {
    readonly max: { readonly wallSeconds: number; readonly sdkDispatches: number };
    readonly xhigh: { readonly wallSeconds: number; readonly sdkDispatches: number };
  };
  readonly xhighWallImprovement: number;
  readonly xhighDispatchImprovement: number;
  readonly xhighWallWinRate: number;
  readonly xhighDispatchWinRate: number;
  readonly recommendation: "max" | "xhigh" | "no-change";
  readonly reason: string;
}

export interface EffortStudyAnalysis {
  readonly schema_version: 1;
  readonly runCount: number;
  readonly pairCount: number;
  readonly incompletePairs: readonly string[];
  readonly runs: readonly EffortStudyRun[];
  readonly decisions: readonly ModelDecision[];
}

export function buildEffortStudyPlan(): EffortStudyPlan {
  const cells: EffortStudyCell[] = [];
  let ordinal = 0;
  let pairOrdinal = 0;
  for (const model of MODELS) {
    for (const agent of AGENTS) {
      for (const scenario of SCENARIOS) {
        for (let repetition = 1; repetition <= REPETITIONS; repetition += 1) {
          pairOrdinal += 1;
          const pairId = `${model}-${agent}-${scenario}-r${repetition}`;
          const order: readonly Effort[] =
            pairOrdinal % 2 === 1 ? ["max", "xhigh"] : ["xhigh", "max"];
          for (const [index, effort] of order.entries()) {
            ordinal += 1;
            cells.push({
              ordinal,
              pair_id: pairId,
              provider: "kiro-local",
              model,
              agent,
              scenario,
              repetition,
              effort,
              order_in_pair: (index + 1) as 1 | 2,
              worker_count: 1,
            });
          }
        }
      }
    }
  }
  return { schema_version: 1, design: "paired-ab-ba", cells };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function boolValue(value: unknown): boolean {
  return value === true;
}

function readEvents(path: string): Record<string, unknown>[] {
  try {
    return readFileSync(path, "utf8")
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
  } catch {
    return [];
  }
}

function startedAtMilliseconds(value: string): number | undefined {
  const match =
    /^(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})T(?<hour>\d{2})(?<minute>\d{2})(?<second>\d{2})Z$/u.exec(
      value,
    );
  if (!match?.groups) return undefined;
  return Date.UTC(
    Number(match.groups.year),
    Number(match.groups.month) - 1,
    Number(match.groups.day),
    Number(match.groups.hour),
    Number(match.groups.minute),
    Number(match.groups.second),
  );
}

export function eventsInRunWindow(
  events: readonly Record<string, unknown>[],
  startedAt: string,
  durationSeconds: number,
): Record<string, unknown>[] {
  const started = startedAtMilliseconds(startedAt);
  if (started === undefined) return [...events];
  const since = started - 10_000;
  const until = started + durationSeconds * 1_000 + 20_000;
  return events.filter((event) => {
    const timestamp = stringValue(event.timestamp);
    if (!timestamp) return false;
    const milliseconds = Date.parse(timestamp);
    return Number.isFinite(milliseconds) && milliseconds >= since && milliseconds <= until;
  });
}

export function correlateRuntimeEvents(
  events: readonly Record<string, unknown>[],
  conversationHash?: string,
): Record<string, unknown>[] {
  if (!conversationHash) return [...events];
  const requestIds = new Set(
    events
      .filter((event) => event.conversation_hash === conversationHash)
      .map((event) => stringValue(event.request_id))
      .filter(Boolean),
  );
  return events.filter(
    (event) =>
      event.conversation_hash === conversationHash || requestIds.has(stringValue(event.request_id)),
  );
}

function runtimeMetrics(
  events: readonly Record<string, unknown>[],
  conversationHash?: string,
): RuntimeMetrics {
  const correlated = correlateRuntimeEvents(events, conversationHash);
  const requestIds = new Set<string>();
  const efforts = new Set<string>();
  const accountHashes = new Set<string>();
  let dispatches = 0;
  let terminals = 0;
  let witnessed = 0;
  let errors = 0;
  for (const event of correlated) {
    const requestId = stringValue(event.request_id);
    if (requestId) requestIds.add(requestId);
    const accountHash = stringValue(event.account_hash);
    if (accountHash) accountHashes.add(accountHash);
    const name = stringValue(event.event);
    if (name === "sdk_dispatch_started") {
      dispatches += 1;
      const effort = stringValue(event.effort);
      if (effort) efforts.add(effort);
    }
    if (name === "sdk_stream_terminal") {
      terminals += 1;
      if (event.completion_witnessed === true) witnessed += 1;
    }
    if (
      name === "sdk_stream_upstream_error" ||
      name === "request_transform_rejected" ||
      name === "pipeline_internal_error"
    ) {
      errors += 1;
    }
  }
  return {
    providerRequestCount: requestIds.size,
    sdkDispatchCount: dispatches,
    terminalCount: terminals,
    allTerminalsWitnessed: terminals > 0 && witnessed === terminals,
    providerErrorCount: errors,
    efforts: [...efforts].sort(),
    accountHashes: [...accountHashes].sort(),
  };
}

function logicalModel(value: string): string {
  const slash = value.indexOf("/");
  return slash >= 0 ? value.slice(slash + 1) : value;
}

function pairId(model: string, agent: string, scenario: string, repetition: number): string {
  return `${logicalModel(model)}-${agent}-${scenario}-r${repetition}`;
}

function parseRun(metaPath: string): EffortStudyRun {
  const raw: unknown = JSON.parse(readFileSync(metaPath, "utf8"));
  if (!isRecord(raw)) throw new TypeError(`Invalid meta object: ${metaPath}`);
  const provenance = isRecord(raw.provenance) ? raw.provenance : {};
  const grade = isRecord(raw.grade) ? raw.grade : {};
  const kiroRuntime = isRecord(raw.kiro_runtime) ? raw.kiro_runtime : {};
  const model = logicalModel(stringValue(provenance.model));
  const effort = stringValue(provenance.effort || provenance.effective_effort);
  const agent = stringValue(raw.agent);
  const scenario = stringValue(raw.scenario);
  const repetition = numberValue(raw.iteration);
  const durationSeconds = numberValue(raw.duration_seconds);
  const rawLogSource = stringValue(kiroRuntime.log_source);
  const eventSource =
    rawLogSource && existsSync(rawLogSource)
      ? eventsInRunWindow(readEvents(rawLogSource), stringValue(raw.started_at), durationSeconds)
      : readEvents(join(dirname(metaPath), "kiro-provider-events.jsonl"));
  const runtime = runtimeMetrics(
    eventSource,
    stringValue(kiroRuntime.selected_conversation_hash) || undefined,
  );
  const exactEffort = runtime.efforts.length === 1 && runtime.efforts[0] === effort;
  const score = numberValue(grade.score);
  const exitCode = numberValue(raw.exit_code);
  const graderExitCode = numberValue(raw.grader_exit_code);
  const timedOut = boolValue(raw.timed_out);
  const clean =
    score === 100 &&
    exitCode === 0 &&
    graderExitCode === 0 &&
    !timedOut &&
    exactEffort &&
    runtime.providerErrorCount === 0 &&
    runtime.allTerminalsWitnessed;
  return {
    runId: stringValue(raw.run_id) || basename(dirname(metaPath)),
    pairId: pairId(model, agent, scenario, repetition),
    model,
    agent,
    scenario,
    repetition,
    effort,
    durationSeconds,
    score,
    exitCode,
    graderExitCode,
    timedOut,
    runtime,
    exactEffort,
    clean,
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

function decisionForModel(
  model: string,
  pairs: ReadonlyArray<readonly [EffortStudyRun, EffortStudyRun]>,
): ModelDecision {
  const maxRuns = pairs.map(([left, right]) => (left.effort === "max" ? left : right));
  const xhighRuns = pairs.map(([left, right]) => (left.effort === "xhigh" ? left : right));
  const maxWall = median(maxRuns.map((run) => run.durationSeconds));
  const xhighWall = median(xhighRuns.map((run) => run.durationSeconds));
  const maxDispatches = median(maxRuns.map((run) => run.runtime.sdkDispatchCount));
  const xhighDispatches = median(xhighRuns.map((run) => run.runtime.sdkDispatchCount));
  const xhighWallWins = pairs.filter(([left, right]) => {
    const max = left.effort === "max" ? left : right;
    const xhigh = left.effort === "xhigh" ? left : right;
    return xhigh.durationSeconds < max.durationSeconds;
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
  let recommendation: ModelDecision["recommendation"] = "no-change";
  let reason = "Neither effort cleared the 15% median and 70% paired-win gate.";
  if (!allClean) {
    reason = "Quality, runtime, effort, terminal-witness, or provider-error gate failed.";
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
            return max.durationSeconds < xhigh.durationSeconds;
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
      max: { wallSeconds: maxWall, sdkDispatches: maxDispatches },
      xhigh: { wallSeconds: xhighWall, sdkDispatches: xhighDispatches },
    },
    xhighWallImprovement: wallImprovement,
    xhighDispatchImprovement: dispatchImprovement,
    xhighWallWinRate: wallWinRate,
    xhighDispatchWinRate: dispatchWinRate,
    recommendation,
    reason,
  };
}

export function analyzeEffortStudyRuns(runs: readonly EffortStudyRun[]): EffortStudyAnalysis {
  const grouped = new Map<string, EffortStudyRun[]>();
  for (const run of runs) {
    const bucket = grouped.get(run.pairId) ?? [];
    bucket.push(run);
    grouped.set(run.pairId, bucket);
  }
  const incompletePairs: string[] = [];
  const completePairs: Array<readonly [EffortStudyRun, EffortStudyRun]> = [];
  for (const [id, rows] of grouped) {
    const max = rows.find((run) => run.effort === "max");
    const xhigh = rows.find((run) => run.effort === "xhigh");
    if (!max || !xhigh || rows.length !== 2) incompletePairs.push(id);
    else completePairs.push([max, xhigh]);
  }
  const decisions = MODELS.map((model) =>
    decisionForModel(
      model,
      completePairs.filter(([run]) => run.model === model),
    ),
  );
  return {
    schema_version: 1,
    runCount: runs.length,
    pairCount: completePairs.length,
    incompletePairs: incompletePairs.sort(),
    runs: [...runs].sort((left, right) => left.runId.localeCompare(right.runId)),
    decisions,
  };
}

async function loadRuns(root: string): Promise<EffortStudyRun[]> {
  const glob = new Bun.Glob("**/meta.json");
  const paths = [...glob.scanSync({ cwd: root, absolute: true })].sort();
  return paths.map(parseRun);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const out = argument("--out");
  let value: EffortStudyPlan | EffortStudyAnalysis;
  if (command === "plan") {
    value = buildEffortStudyPlan();
  } else if (command === "analyze") {
    const results = argument("--results");
    if (!results) {
      throw new Error("analyze requires --results <directory>");
    }
    value = analyzeEffortStudyRuns(await loadRuns(results));
  } else {
    throw new Error(
      "usage: bun run scripts/effort-study.ts <plan|analyze> [--results <dir>] [--out <json>]",
    );
  }
  const rendered = `${JSON.stringify(value, null, 2)}\n`;
  if (out) writeFileSync(out, rendered);
  else process.stdout.write(rendered);
}

if (import.meta.main) await main();
