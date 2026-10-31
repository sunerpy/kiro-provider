import { createHash } from "node:crypto";
import { createReadStream, lstatSync, type Stats, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

export const BUILDER_ID_SERVICE_PROFILE_ARN =
  "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";

const SOURCE_MARKERS = [
  "crates/fig_api_client/src/profile_resolver.rs",
  "crates/chat-cli/src/api_client/mod.rs",
  "crates/chat-cli-v2/src/api_client/mod.rs",
] as const;
const MAX_BINARY_BYTES = 1024 * 1024 * 1024;
const MAX_MATCHES_PER_MARKER = 1_000;
const CHUNK_BYTES = 64 * 1024;

export interface BuilderProfileBinaryEvidence {
  readonly file: string;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly service_profile_occurrences: number;
  readonly source_markers: Readonly<Record<(typeof SOURCE_MARKERS)[number], boolean>>;
  readonly passed: boolean;
}

function unchanged(before: Stats, after: Stats): boolean {
  return (
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.dev === after.dev &&
    before.ino === after.ino
  );
}

/** Static shipped-artifact evidence only. This never executes the selected binary or contacts Kiro. */
export async function inspectBuilderProfileBinary(
  path: string,
): Promise<BuilderProfileBinaryEvidence> {
  if (!isAbsolute(path)) throw new Error("--binary must be an absolute path");
  const link = lstatSync(path);
  if (!link.isFile() || link.isSymbolicLink()) throw new Error("--binary must name a regular file");
  const before = statSync(path);
  if (before.size <= 0 || before.size > MAX_BINARY_BYTES) {
    throw new Error(`--binary size must be between 1 and ${MAX_BINARY_BYTES} bytes`);
  }

  const markers = [BUILDER_ID_SERVICE_PROFILE_ARN, ...SOURCE_MARKERS] as const;
  const bytes = markers.map((marker) => Buffer.from(marker, "utf8"));
  const counts = new Map<string, number>(markers.map((marker) => [marker, 0]));
  const maxMarkerBytes = Math.max(...bytes.map((marker) => marker.byteLength));
  const digest = createHash("sha256");
  let offset = 0;
  let tail = Buffer.alloc(0);

  for await (const raw of createReadStream(path, { highWaterMark: CHUNK_BYTES })) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    digest.update(chunk);
    const window = Buffer.concat([tail, chunk]);
    const base = offset - tail.byteLength;
    for (const [index, marker] of markers.entries()) {
      const needle = bytes[index] as Buffer;
      let from = 0;
      for (;;) {
        const found = window.indexOf(needle, from);
        if (found < 0) break;
        const absolute = base + found;
        if (absolute + needle.byteLength > offset) {
          const count = (counts.get(marker) ?? 0) + 1;
          if (count > MAX_MATCHES_PER_MARKER) throw new Error("binary marker count exceeded");
          counts.set(marker, count);
        }
        from = found + 1;
      }
    }
    offset += chunk.byteLength;
    tail = Buffer.from(window.subarray(Math.max(0, window.byteLength - maxMarkerBytes + 1)));
  }

  const after = statSync(path);
  if (!unchanged(before, after) || offset !== before.size) {
    throw new Error("binary changed during inspection");
  }
  const sourceMarkers = Object.fromEntries(
    SOURCE_MARKERS.map((marker) => [marker, (counts.get(marker) ?? 0) > 0]),
  ) as Record<(typeof SOURCE_MARKERS)[number], boolean>;
  const serviceProfileOccurrences = counts.get(BUILDER_ID_SERVICE_PROFILE_ARN) ?? 0;
  return {
    file: basename(path),
    size_bytes: before.size,
    sha256: digest.digest("hex"),
    service_profile_occurrences: serviceProfileOccurrences,
    source_markers: sourceMarkers,
    passed: serviceProfileOccurrences > 0 && Object.values(sourceMarkers).some(Boolean),
  };
}

function binaryPaths(argv: readonly string[]): string[] {
  const paths: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--binary" || !argv[index + 1]) {
      throw new Error("Usage: probe-builder-id-profile.ts --binary <absolute-path> [--binary ...]");
    }
    paths.push(argv[index + 1] as string);
    index += 1;
  }
  if (paths.length === 0) {
    throw new Error("Usage: probe-builder-id-profile.ts --binary <absolute-path> [--binary ...]");
  }
  return paths;
}

if (import.meta.main) {
  try {
    const binaries = await Promise.all(
      binaryPaths(process.argv.slice(2)).map(inspectBuilderProfileBinary),
    );
    const passed = binaries.every((binary) => binary.passed);
    console.log(
      JSON.stringify(
        {
          schema_version: 1,
          observation: "static-shipped-artifact",
          executes_target: false,
          network_requests: 0,
          expected_service_profile: BUILDER_ID_SERVICE_PROFILE_ARN,
          binaries,
          passed,
        },
        null,
        2,
      ),
    );
    if (!passed) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
