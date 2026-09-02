const GPT_SOL_MODEL = /^gpt-5\.6-sol(?:-|$)/;

function normalizedReasoning(text: string): string {
  return text.trim();
}

export function isGptSolReasoningPlaceholder(model: string, text: string): boolean {
  if (!GPT_SOL_MODEL.test(model)) return false;
  const normalized = normalizedReasoning(text);
  return normalized === "..." || normalized === "…";
}

export function couldStillBeGptSolReasoningPlaceholder(model: string, text: string): boolean {
  if (!GPT_SOL_MODEL.test(model)) return false;
  const normalized = normalizedReasoning(text);
  return (
    normalized === "" ||
    normalized === "." ||
    normalized === ".." ||
    normalized === "..." ||
    normalized === "…"
  );
}
