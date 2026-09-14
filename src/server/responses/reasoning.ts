const GPT_56_MODEL = /^gpt-5\.6-(?:sol|terra|luna)(?:-|$)/;

function normalizedReasoning(text: string): string {
  return text.trim();
}

export function isGpt56ReasoningPlaceholder(model: string, text: string): boolean {
  if (!GPT_56_MODEL.test(model)) return false;
  const normalized = normalizedReasoning(text);
  return normalized === "..." || normalized === "…";
}

export function couldStillBeGpt56ReasoningPlaceholder(model: string, text: string): boolean {
  if (!GPT_56_MODEL.test(model)) return false;
  const normalized = normalizedReasoning(text);
  return (
    normalized === "" ||
    normalized === "." ||
    normalized === ".." ||
    normalized === "..." ||
    normalized === "…"
  );
}

export function isGpt56Model(model: string): boolean {
  return GPT_56_MODEL.test(model);
}
