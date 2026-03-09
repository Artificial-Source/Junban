import { describe, it, expect } from "vitest";
import { parseTask } from "../../src/parser/task-parser.js";

describe("parseTask", () => {
  it("parses a simple task title", () => {
    const result = parseTask("buy milk");
    expect(result.title).toBe("buy milk");
    expect(result.priority).toBeNull();
    expect(result.tags).toEqual([]);
    expect(result.project).toBeNull();
    expect(result.dueDate).toBeNull();
    expect(result.dueTime).toBe(false);
  });

  it("extracts priority", () => {
    const result = parseTask("buy milk p1");
    expect(result.title).toBe("buy milk");
    expect(result.priority).toBe(1);
  });

  it("extracts tags", () => {
    const result = parseTask("review PR #dev #urgent");
    expect(result.title).toBe("review PR");
    expect(result.tags).toEqual(["dev", "urgent"]);
  });

  it("extracts project", () => {
    const result = parseTask("deploy service +work");
    expect(result.title).toBe("deploy service");
    expect(result.project).toBe("work");
  });

  it("extracts date", () => {
    const result = parseTask("buy milk tomorrow");
    expect(result.title).toBe("buy milk");
    expect(result.dueDate).not.toBeNull();
    expect(result.dueTime).toBe(false);
  });

  it("removes connector words before dates", () => {
    const result = parseTask("Buy grocery by tomorrow");
    expect(result.title).toBe("Buy grocery");
    expect(result.dueDate).not.toBeNull();
    expect(result.dueTime).toBe(false);
  });

  it("extracts date with time", () => {
    const result = parseTask("meeting tomorrow at 3pm");
    expect(result.title).toBe("meeting");
    expect(result.dueDate).not.toBeNull();
    expect(result.dueDate!.getHours()).toBe(15);
    expect(result.dueTime).toBe(true);
  });

  it("handles all fields together", () => {
    const result = parseTask("buy milk tomorrow p1 #groceries +shopping");
    expect(result.title).toBe("buy milk");
    expect(result.priority).toBe(1);
    expect(result.tags).toEqual(["groceries"]);
    expect(result.project).toBe("shopping");
    expect(result.dueDate).not.toBeNull();
  });

  it("handles multiple tags with priority and project", () => {
    const result = parseTask("review code p2 #dev #review +work");
    expect(result.title).toBe("review code");
    expect(result.priority).toBe(2);
    expect(result.tags).toEqual(["dev", "review"]);
    expect(result.project).toBe("work");
  });

  it("trims whitespace", () => {
    const result = parseTask("  buy milk  ");
    expect(result.title).toBe("buy milk");
  });

  it("handles empty-ish input after extraction", () => {
    const result = parseTask("p1 #tag +project");
    expect(result.title).toBe("");
    expect(result.priority).toBe(1);
    expect(result.tags).toEqual(["tag"]);
    expect(result.project).toBe("project");
  });

  it("handles tags at the start", () => {
    const result = parseTask("#urgent fix the bug");
    expect(result.tags).toEqual(["urgent"]);
    expect(result.title).toBe("fix the bug");
  });

  it("extracts recurrence", () => {
    const result = parseTask("standup daily");
    expect(result.title).toBe("standup");
    expect(result.recurrence).toBe("daily");
  });

  it("returns null recurrence when none present", () => {
    const result = parseTask("buy milk");
    expect(result.recurrence).toBeNull();
  });

  it("handles recurrence with priority, tags, and project", () => {
    const result = parseTask("buy milk daily p2 #groceries +shopping");
    expect(result.title).toBe("buy milk");
    expect(result.recurrence).toBe("daily");
    expect(result.priority).toBe(2);
    expect(result.tags).toEqual(["groceries"]);
    expect(result.project).toBe("shopping");
  });

  it("handles 'every N days' recurrence with date", () => {
    const result = parseTask("water plants every 3 days");
    expect(result.title).toBe("water plants");
    expect(result.recurrence).toBe("every 3 days");
  });

  it("parses 'deadline friday' keyword into deadline field", () => {
    const result = parseTask("submit report deadline friday p1");
    expect(result.title).toBe("submit report");
    expect(result.deadline).not.toBeNull();
    expect(result.deadline!.getDay()).toBe(5); // Friday
    expect(result.priority).toBe(1);
    expect(result.dueDate).toBeNull();
  });

  it("parses !!friday into deadline field", () => {
    const result = parseTask("submit report !!friday");
    expect(result.title).toBe("submit report");
    expect(result.deadline).not.toBeNull();
    expect(result.deadline!.getDay()).toBe(5); // Friday
    expect(result.dueDate).toBeNull();
  });

  it("parses both dueDate and deadline independently", () => {
    const result = parseTask("submit report tomorrow deadline friday");
    expect(result.title).toBe("submit report");
    expect(result.dueDate).not.toBeNull();
    expect(result.deadline).not.toBeNull();
    // deadline should be Friday, dueDate should be tomorrow
    expect(result.deadline!.getDay()).toBe(5);
  });

  it("parses ~30m duration", () => {
    const result = parseTask("write tests ~30m");
    expect(result.title).toBe("write tests");
    expect(result.estimatedMinutes).toBe(30);
  });

  it("parses ~2h duration", () => {
    const result = parseTask("deep work ~2h #focus");
    expect(result.title).toBe("deep work");
    expect(result.estimatedMinutes).toBe(120);
    expect(result.tags).toEqual(["focus"]);
  });

  it("parses ~1h30m compound duration", () => {
    const result = parseTask("meeting ~1h30m p2");
    expect(result.title).toBe("meeting");
    expect(result.estimatedMinutes).toBe(90);
    expect(result.priority).toBe(2);
  });

  it("returns null estimatedMinutes when no duration", () => {
    const result = parseTask("buy milk");
    expect(result.estimatedMinutes).toBeNull();
  });
});
