/**
 * extract_tasks_from_text tool — extracts actionable tasks from meeting notes,
 * emails, or other unstructured text. Supports dry-run preview and batch creation.
 */

import type { ToolRegistry } from "../registry.js";

/** Shape returned by the LLM when parsing text for tasks. */
interface ExtractedTask {
  title: string;
  priority?: number | null;
  dueDate?: string | null;
  description?: string | null;
  assigneeHint?: string | null;
}

/**
 * Attempts to parse the LLM response into a task array.
 * Tolerates common LLM output quirks (markdown fences, extra keys, etc.).
 */
function parseLLMResponse(raw: string): ExtractedTask[] {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  // Accept either a bare array or { tasks: [...] }
  let arr: unknown[];
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (
    parsed &&
    typeof parsed === "object" &&
    "tasks" in parsed &&
    Array.isArray((parsed as Record<string, unknown>).tasks)
  ) {
    arr = (parsed as Record<string, unknown>).tasks as unknown[];
  } else {
    return [];
  }

  const tasks: ExtractedTask[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.title !== "string" || obj.title.trim().length === 0) continue;
    tasks.push({
      title: obj.title.trim(),
      priority:
        typeof obj.priority === "number" && obj.priority >= 1 && obj.priority <= 4
          ? obj.priority
          : null,
      dueDate: typeof obj.dueDate === "string" && obj.dueDate.length > 0 ? obj.dueDate : null,
      description:
        typeof obj.description === "string" && obj.description.length > 0 ? obj.description : null,
      assigneeHint:
        typeof obj.assigneeHint === "string" && obj.assigneeHint.length > 0
          ? obj.assigneeHint
          : null,
    });
  }
  return tasks;
}

const EXTRACTION_PROMPT = `You are a task extraction assistant. Analyze the following text and extract all actionable items as tasks.

Rules:
- Each task title should start with a verb (e.g., "Review", "Send", "Update")
- Guess priority 1-4 (1=urgent, 4=low) based on context and urgency language
- Extract due dates as ISO 8601 strings when mentioned (e.g., "by Friday" → next Friday's date)
- Include a brief description if additional context is available
- Include assigneeHint if a person is mentioned in relation to the task
- Ignore non-actionable statements, opinions, or status updates

Return a JSON array of objects with these fields:
{ "title": string, "priority": number|null, "dueDate": string|null, "description": string|null, "assigneeHint": string|null }

Return ONLY the JSON array, no extra text.

Text to analyze:
`;

export function registerExtractTasksFromTextTool(registry: ToolRegistry): void {
  registry.register(
    {
      name: "extract_tasks_from_text",
      description:
        "Extract actionable tasks from unstructured text such as meeting notes, emails, or brain dumps. " +
        "Supports dry-run preview (default) and batch creation. " +
        'Use when the user says "extract tasks from...", "turn this into tasks", or pastes meeting notes.',
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The unstructured text to extract tasks from (meeting notes, email, etc.)",
          },
          projectId: {
            type: "string",
            description: "Optional project ID to assign all extracted tasks to",
          },
          dryRun: {
            type: "boolean",
            description:
              "If true (default), return preview without creating tasks. If false, create the tasks.",
          },
        },
        required: ["text"],
      },
    },
    async (args, ctx) => {
      const text = (args.text as string).trim();
      const projectId = (args.projectId as string) || null;
      const dryRun = (args.dryRun as boolean) ?? true;

      if (!text) {
        return JSON.stringify({ error: "No text provided", tasks: [], created: false, count: 0 });
      }

      // Use a simple heuristic extraction when no LLM pipeline is available.
      // In real usage the chat pipeline invokes this tool with LLM context,
      // but the tool itself does the extraction via a nested LLM call concept.
      // For deterministic fallback, we do line-based extraction.
      let extracted: ExtractedTask[];

      // Try LLM extraction via context if available (the pipeline passes sendMessage on ctx)
      const sendMessage = (ctx as unknown as Record<string, unknown>).sendMessage as
        | ((prompt: string) => Promise<string>)
        | undefined;

      if (typeof sendMessage === "function") {
        try {
          const llmResponse = await sendMessage(EXTRACTION_PROMPT + text);
          extracted = parseLLMResponse(llmResponse);
        } catch {
          // Fallback to heuristic if LLM fails
          extracted = heuristicExtract(text);
        }
      } else {
        extracted = heuristicExtract(text);
      }

      if (extracted.length === 0) {
        return JSON.stringify({
          tasks: [],
          created: false,
          count: 0,
          message: "No actionable tasks found in the provided text.",
        });
      }

      if (dryRun) {
        return JSON.stringify({
          tasks: extracted.map((t) => ({
            ...t,
            projectId,
          })),
          created: false,
          count: extracted.length,
        });
      }

      // Create the tasks
      const created: Array<{ id: string; title: string }> = [];
      const errors: string[] = [];

      for (const t of extracted) {
        try {
          const task = await ctx.taskService.create({
            title: t.title,
            description: t.description ?? null,
            priority: t.priority ?? null,
            dueDate: t.dueDate ?? null,
            dueTime: false,
            projectId: projectId ?? null,
            tags: [],
            recurrence: null,
            remindAt: null,
            estimatedMinutes: null,
            deadline: null,
            isSomeday: false,
            sectionId: null,
          });
          created.push({ id: task.id, title: task.title });
        } catch (err) {
          errors.push(
            `Failed to create "${t.title}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return JSON.stringify({
        tasks: extracted.map((t) => ({ ...t, projectId })),
        created: true,
        count: created.length,
        createdTasks: created,
        ...(errors.length > 0 ? { errors } : {}),
      });
    },
  );
}

/**
 * Heuristic line-based extraction as a fallback when no LLM is available.
 * Looks for bullet points, numbered lists, and action-oriented lines.
 */
function heuristicExtract(text: string): ExtractedTask[] {
  const lines = text
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const tasks: ExtractedTask[] = [];

  // Common action verbs that indicate a task
  const actionVerbs =
    /^(review|send|update|create|schedule|prepare|follow[\s-]?up|contact|call|email|write|fix|implement|deploy|check|set[\s-]?up|complete|finalize|submit|organize|plan|discuss|investigate|research|design|test|build|draft|arrange|confirm|approve|cancel|assign|notify|share|clean|move|order|book|coordinate)/i;

  // Patterns that indicate list items
  const listPrefix = /^(?:[-*+]|\d+[.)]\s*|(?:TODO|ACTION|AI|TASK)[:\s]+)/i;

  for (const line of lines) {
    // Remove list prefix
    const cleaned = line.replace(listPrefix, "").trim();
    if (!cleaned || cleaned.length < 5) continue;

    // Check if line looks like a task (starts with verb or was a list item)
    const wasListItem = listPrefix.test(line);
    const startsWithVerb = actionVerbs.test(cleaned);

    if (wasListItem || startsWithVerb) {
      // Ensure title starts with a capital letter
      const title = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);

      // Simple priority guessing
      let priority: number | null = null;
      if (/\b(urgent|asap|critical|immediately)\b/i.test(cleaned)) priority = 1;
      else if (/\b(important|high[\s-]?priority|soon)\b/i.test(cleaned)) priority = 2;
      else if (/\b(low[\s-]?priority|whenever|someday|eventually)\b/i.test(cleaned)) priority = 4;

      tasks.push({
        title,
        priority,
        dueDate: null,
        description: null,
        assigneeHint: null,
      });
    }
  }

  return tasks;
}
