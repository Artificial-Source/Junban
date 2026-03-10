/**
 * suggest_tags + find_similar_tasks tools — intent-based organization.
 * Supports Issue #8 (Intent-Based Organization).
 */

import type { ToolRegistry } from "../registry.js";
import type { Task } from "../../../core/types.js";

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "must",
  "can",
  "could",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "up",
  "down",
  "and",
  "but",
  "or",
  "nor",
  "not",
  "so",
  "yet",
  "both",
  "either",
  "neither",
  "each",
  "every",
  "all",
  "any",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "only",
  "own",
  "same",
  "than",
  "too",
  "very",
  "just",
  "about",
  "it",
  "its",
  "my",
  "me",
  "i",
  "this",
  "that",
  "these",
  "those",
  "he",
  "she",
  "they",
  "we",
  "you",
]);

/** Extract meaningful keywords from text. */
function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/);
  return new Set(words.filter((w) => w.length > 1 && !STOP_WORDS.has(w)));
}

/** Compute Jaccard similarity between two sets. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/** Compute word overlap count between two sets. */
function overlapCount(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const word of a) {
    if (b.has(word)) count++;
  }
  return count;
}

export function registerSmartOrganizeTools(registry: ToolRegistry): void {
  registry.register(
    {
      name: "suggest_tags",
      description:
        "Suggest tags for a task based on its title and similarity to other tagged tasks. " +
        "Use when a user creates or has tasks without tags.",
      parameters: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "The ID of the task to suggest tags for",
          },
        },
        required: ["taskId"],
      },
    },
    async (args, ctx) => {
      const taskId = args.taskId as string;

      // Get the target task
      const allTasks = await ctx.taskService.list();
      const completedTasks = await ctx.taskService.list({ status: "completed" });
      const allWithCompleted = [...allTasks, ...completedTasks];

      const target = allWithCompleted.find((t) => t.id === taskId);
      if (!target) {
        return JSON.stringify({ error: `Task not found: ${taskId}` });
      }

      const targetWords = tokenize(target.title);
      if (targetWords.size === 0) {
        return JSON.stringify({
          taskTitle: target.title,
          suggestedTags: [],
          existingTags: target.tags.map((t) => t.name),
        });
      }

      // Score each tag by the sum of word overlap with tasks that have it
      const tagScores = new Map<string, { score: number; matchedTasks: string[] }>();

      for (const task of allWithCompleted) {
        if (task.tags.length === 0) continue;
        if (task.id === taskId) continue;

        const taskWords = tokenize(task.title);
        const overlap = overlapCount(targetWords, taskWords);
        if (overlap === 0) continue;

        for (const tag of task.tags) {
          const entry = tagScores.get(tag.name);
          if (entry) {
            entry.score += overlap;
            if (entry.matchedTasks.length < 3) {
              entry.matchedTasks.push(task.title);
            }
          } else {
            tagScores.set(tag.name, { score: overlap, matchedTasks: [task.title] });
          }
        }
      }

      // Filter out tags the task already has
      const existingTagNames = new Set(target.tags.map((t) => t.name));
      const suggestions = Array.from(tagScores.entries())
        .filter(([name]) => !existingTagNames.has(name))
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, 5)
        .map(([tag, data]) => ({
          tag,
          score: data.score,
          reason: `Similar to: ${data.matchedTasks.slice(0, 2).join(", ")}`,
        }));

      return JSON.stringify({
        taskTitle: target.title,
        suggestedTags: suggestions,
        existingTags: target.tags.map((t) => t.name),
      });
    },
  );

  registry.register(
    {
      name: "find_similar_tasks",
      description:
        "Find groups of similar or duplicate tasks based on title similarity. " +
        "Use when asked to clean up, find duplicates, or consolidate tasks.",
      parameters: {
        type: "object",
        properties: {
          search: {
            type: "string",
            description: "Text to find similar tasks for",
          },
          taskId: {
            type: "string",
            description: "Task ID to find similar tasks for (alternative to search)",
          },
        },
      },
    },
    async (args, ctx) => {
      const pending = await ctx.taskService.list({ status: "pending" });

      let referenceText: string;
      if (args.taskId) {
        const target = pending.find((t) => t.id === (args.taskId as string));
        if (!target) {
          return JSON.stringify({ error: `Task not found: ${args.taskId}` });
        }
        referenceText = target.title;
      } else if (args.search) {
        referenceText = args.search as string;
      } else {
        // No reference — find all similar groups among pending tasks
        return JSON.stringify(findAllSimilarGroups(pending));
      }

      const refWords = tokenize(referenceText);
      if (refWords.size === 0) {
        return JSON.stringify({ groups: [] });
      }

      const similar: { id: string; title: string; similarity: number }[] = [];
      for (const task of pending) {
        if (args.taskId && task.id === (args.taskId as string)) continue;
        const taskWords = tokenize(task.title);
        const sim = jaccard(refWords, taskWords);
        if (sim > 0.3) {
          similar.push({
            id: task.id,
            title: task.title,
            similarity: Math.round(sim * 100) / 100,
          });
        }
      }

      similar.sort((a, b) => b.similarity - a.similarity);

      const groups =
        similar.length > 0
          ? [
              {
                reference: referenceText,
                tasks: similar.slice(0, 10),
                suggestedAction: similar.some((t) => t.similarity > 0.7)
                  ? "These tasks look like duplicates — consider merging or deleting extras."
                  : "These tasks are related — consider grouping under a project or parent task.",
              },
            ]
          : [];

      return JSON.stringify({ groups });
    },
  );
}

export function registerCheckDuplicatesTool(registry: ToolRegistry): void {
  registry.register(
    {
      name: "check_duplicates",
      description:
        "Check if a task title is similar to existing pending tasks. " +
        "Use proactively after creating a task to warn about potential duplicates.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Task title to check against existing tasks",
          },
          threshold: {
            type: "number",
            description: "Jaccard similarity threshold (0-1, default 0.5)",
          },
        },
        required: ["title"],
      },
    },
    async (args, ctx) => {
      const title = args.title as string;
      const threshold = (args.threshold as number) ?? 0.5;

      const pending = await ctx.taskService.list({ status: "pending" });
      const inputTokens = tokenize(title);

      if (inputTokens.size === 0) {
        return JSON.stringify({ duplicatesFound: false, matches: [] });
      }

      const matches: { id: string; title: string; similarity: number }[] = [];

      for (const task of pending) {
        const taskTokens = tokenize(task.title);
        const sim = jaccard(inputTokens, taskTokens);
        if (sim >= threshold) {
          matches.push({
            id: task.id,
            title: task.title,
            similarity: Math.round(sim * 100) / 100,
          });
        }
      }

      matches.sort((a, b) => b.similarity - a.similarity);

      return JSON.stringify({
        duplicatesFound: matches.length > 0,
        matches: matches.slice(0, 10),
      });
    },
  );
}

function findAllSimilarGroups(tasks: Task[]): {
  groups: {
    tasks: { id: string; title: string; similarity: number }[];
    suggestedAction: string;
  }[];
} {
  const tokenized = tasks.map((t) => ({
    task: t,
    words: tokenize(t.title),
  }));

  const visited = new Set<string>();
  const groups: {
    tasks: { id: string; title: string; similarity: number }[];
    suggestedAction: string;
  }[] = [];

  for (let i = 0; i < tokenized.length; i++) {
    if (visited.has(tokenized[i].task.id)) continue;

    const cluster: { id: string; title: string; similarity: number }[] = [
      { id: tokenized[i].task.id, title: tokenized[i].task.title, similarity: 1.0 },
    ];

    for (let j = i + 1; j < tokenized.length; j++) {
      if (visited.has(tokenized[j].task.id)) continue;
      const sim = jaccard(tokenized[i].words, tokenized[j].words);
      if (sim > 0.5) {
        cluster.push({
          id: tokenized[j].task.id,
          title: tokenized[j].task.title,
          similarity: Math.round(sim * 100) / 100,
        });
        visited.add(tokenized[j].task.id);
      }
    }

    if (cluster.length > 1) {
      visited.add(tokenized[i].task.id);
      groups.push({
        tasks: cluster,
        suggestedAction: "These tasks look similar — consider merging or deleting duplicates.",
      });
    }
  }

  return { groups };
}
