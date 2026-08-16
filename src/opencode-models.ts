/**
 * OpenCode free-tier model detection — the single definition.
 *
 * Free models on OpenCode Zen use the "-free" suffix, plus a few legacy IDs
 * that predate the convention. Used by worker routing (Zen vs Go upstream)
 * and by the CLI model-list filtering. Do not re-implement elsewhere.
 */

const FREE_MODEL_EXCEPTIONS = new Set(["big-pickle"]);

export function isFreeOpenCodeModel(model: string): boolean {
  return model.endsWith("-free") || FREE_MODEL_EXCEPTIONS.has(model);
}
