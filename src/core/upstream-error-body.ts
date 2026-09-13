import { abortable } from "./pipeline-runtime.js";
import { boundedCleanup } from "./stream-cleanup.js";

// A diagnostic envelope is bounded independently of model input/output budgets.
const MAX_ERROR_BODY_BYTES = 65_536;

export async function readUpstreamErrorBody(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_ERROR_BODY_BYTES) return undefined;
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (signal.aborted) throw error;
    return undefined;
  } finally {
    void boundedCleanup(() => reader.cancel());
  }
}
