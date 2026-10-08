import type { TokenUsage } from "../types";

const COUNTS = ["inputTokens", "outputTokens", "totalTokens", "reasoningTokens", "cachedInputTokens", "cacheWriteInputTokens"] as const;

/** Adds token usage into a list kept per provider and model. */
export function addUsage(list: TokenUsage[], usage: TokenUsage): TokenUsage[] {
  const counts = COUNTS.filter((name) => typeof usage[name] === "number" && Number.isFinite(usage[name]));
  if (!counts.length) return list;
  let entry = list.find((item) => item.provider === usage.provider && item.model === usage.model);
  if (!entry) {
    entry = {};
    if (usage.provider !== undefined) entry.provider = usage.provider;
    if (usage.model !== undefined) entry.model = usage.model;
    list.push(entry);
  }
  for (const name of counts) entry[name] = (entry[name] ?? 0) + usage[name]!;
  return list;
}

/** Merges usage lists, without changing either. */
export function mergeUsage(...lists: (TokenUsage[] | undefined)[]): TokenUsage[] {
  const merged: TokenUsage[] = [];
  for (const list of lists) for (const usage of list ?? []) addUsage(merged, usage);
  return merged;
}
