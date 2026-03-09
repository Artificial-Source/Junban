import { describe, it, expect } from "vitest";
import {
  extractPriority,
  extractTags,
  extractProject,
  extractRecurrence,
  extractDeadline,
  extractDuration,
} from "../../src/parser/grammar.js";

describe("extractPriority", () => {
  it("extracts p1", () => {
    const result = extractPriority("buy milk p1");
    expect(result.priority).toBe(1);
    expect(result.text).toBe("buy milk");
  });

  it("extracts p2", () => {
    const result = extractPriority("review PR p2");
    expect(result.priority).toBe(2);
    expect(result.text).toBe("review PR");
  });

  it("extracts p3", () => {
    const result = extractPriority("clean desk p3");
    expect(result.priority).toBe(3);
    expect(result.text).toBe("clean desk");
  });

  it("extracts p4", () => {
    const result = extractPriority("organize files p4");
    expect(result.priority).toBe(4);
    expect(result.text).toBe("organize files");
  });

  it("is case-insensitive", () => {
    const result = extractPriority("buy milk P1");
    expect(result.priority).toBe(1);
    expect(result.text).toBe("buy milk");
  });

  it("returns null when no priority present", () => {
    const result = extractPriority("buy milk");
    expect(result.priority).toBeNull();
    expect(result.text).toBe("buy milk");
  });

  it("ignores p0 and p5 (out of range)", () => {
    expect(extractPriority("buy milk p0").priority).toBeNull();
    expect(extractPriority("buy milk p5").priority).toBeNull();
  });

  it("handles priority at the beginning", () => {
    const result = extractPriority("p1 buy milk");
    expect(result.priority).toBe(1);
    expect(result.text).toBe("buy milk");
  });

  it("handles priority in the middle", () => {
    const result = extractPriority("buy p2 milk");
    expect(result.priority).toBe(2);
    expect(result.text).toBe("buy milk");
  });

  it("does not match p inside a word", () => {
    const result = extractPriority("setup1 the server");
    expect(result.priority).toBeNull();
  });
});

describe("extractTags", () => {
  it("extracts a single tag", () => {
    const result = extractTags("buy milk #groceries");
    expect(result.tags).toEqual(["groceries"]);
    expect(result.text).toBe("buy milk");
  });

  it("extracts multiple tags", () => {
    const result = extractTags("review PR #dev #urgent");
    expect(result.tags).toEqual(["dev", "urgent"]);
    expect(result.text).toBe("review PR");
  });

  it("lowercases tags", () => {
    const result = extractTags("task #Important #URGENT");
    expect(result.tags).toEqual(["important", "urgent"]);
  });

  it("handles hyphenated tags", () => {
    const result = extractTags("task #follow-up");
    expect(result.tags).toEqual(["follow-up"]);
    expect(result.text).toBe("task");
  });

  it("handles tags with underscores", () => {
    const result = extractTags("task #work_stuff");
    expect(result.tags).toEqual(["work_stuff"]);
  });

  it("returns empty array when no tags present", () => {
    const result = extractTags("buy milk");
    expect(result.tags).toEqual([]);
    expect(result.text).toBe("buy milk");
  });

  it("handles tag at the beginning", () => {
    const result = extractTags("#urgent buy milk");
    expect(result.tags).toEqual(["urgent"]);
    expect(result.text).toBe("buy milk");
  });

  it("handles tags with numbers", () => {
    const result = extractTags("task #sprint3");
    expect(result.tags).toEqual(["sprint3"]);
  });

  it("handles consecutive tags", () => {
    const result = extractTags("#a #b #c");
    expect(result.tags).toEqual(["a", "b", "c"]);
    expect(result.text).toBe("");
  });
});

describe("extractProject", () => {
  it("extracts a project", () => {
    const result = extractProject("buy milk +shopping");
    expect(result.project).toBe("shopping");
    expect(result.text).toBe("buy milk");
  });

  it("returns null when no project present", () => {
    const result = extractProject("buy milk");
    expect(result.project).toBeNull();
    expect(result.text).toBe("buy milk");
  });

  it("handles project at the beginning", () => {
    const result = extractProject("+work review PR");
    expect(result.project).toBe("work");
    expect(result.text).toBe("review PR");
  });

  it("handles hyphenated project names", () => {
    const result = extractProject("task +side-project");
    expect(result.project).toBe("side-project");
    expect(result.text).toBe("task");
  });

  it("handles project with underscores", () => {
    const result = extractProject("task +my_project");
    expect(result.project).toBe("my_project");
  });

  it("extracts only the first project", () => {
    const result = extractProject("task +work +personal");
    expect(result.project).toBe("work");
    // second +personal remains in text
    expect(result.text).toBe("task +personal");
  });
});

describe("extractRecurrence", () => {
  it("extracts 'daily'", () => {
    const result = extractRecurrence("buy milk daily");
    expect(result.recurrence).toBe("daily");
    expect(result.text).toBe("buy milk");
  });

  it("extracts 'weekly'", () => {
    const result = extractRecurrence("standup weekly");
    expect(result.recurrence).toBe("weekly");
    expect(result.text).toBe("standup");
  });

  it("extracts 'monthly'", () => {
    const result = extractRecurrence("pay rent monthly");
    expect(result.recurrence).toBe("monthly");
    expect(result.text).toBe("pay rent");
  });

  it("extracts 'weekdays'", () => {
    const result = extractRecurrence("exercise weekdays");
    expect(result.recurrence).toBe("weekdays");
    expect(result.text).toBe("exercise");
  });

  it("extracts 'every day'", () => {
    const result = extractRecurrence("take vitamins every day");
    expect(result.recurrence).toBe("daily");
    expect(result.text).toBe("take vitamins");
  });

  it("extracts 'every week'", () => {
    const result = extractRecurrence("review goals every week");
    expect(result.recurrence).toBe("weekly");
    expect(result.text).toBe("review goals");
  });

  it("extracts 'every month'", () => {
    const result = extractRecurrence("check budget every month");
    expect(result.recurrence).toBe("monthly");
    expect(result.text).toBe("check budget");
  });

  it("extracts 'every N days'", () => {
    const result = extractRecurrence("water plants every 3 days");
    expect(result.recurrence).toBe("every 3 days");
    expect(result.text).toBe("water plants");
  });

  it("extracts 'every N weeks'", () => {
    const result = extractRecurrence("clean house every 2 weeks");
    expect(result.recurrence).toBe("every 2 weeks");
    expect(result.text).toBe("clean house");
  });

  it("extracts 'every 1 day' as singular", () => {
    const result = extractRecurrence("take meds every 1 day");
    expect(result.recurrence).toBe("every 1 day");
    expect(result.text).toBe("take meds");
  });

  it("is case-insensitive", () => {
    const result = extractRecurrence("run Daily");
    expect(result.recurrence).toBe("daily");
    expect(result.text).toBe("run");
  });

  it("returns null when no recurrence present", () => {
    const result = extractRecurrence("buy milk tomorrow");
    expect(result.recurrence).toBeNull();
    expect(result.text).toBe("buy milk tomorrow");
  });

  it("handles recurrence at the beginning", () => {
    const result = extractRecurrence("daily standup meeting");
    expect(result.recurrence).toBe("daily");
    expect(result.text).toBe("standup meeting");
  });

  it("handles recurrence in the middle", () => {
    const result = extractRecurrence("team weekly sync");
    expect(result.recurrence).toBe("weekly");
    expect(result.text).toBe("team sync");
  });
});

describe("extractDeadline", () => {
  it("extracts deadline with keyword syntax", () => {
    const result = extractDeadline("submit report deadline friday");
    expect(result.deadlineText).toBe("friday");
    expect(result.text).toBe("submit report");
  });

  it("extracts deadline with !! prefix syntax", () => {
    const result = extractDeadline("submit report !!friday");
    expect(result.deadlineText).toBe("friday");
    expect(result.text).toBe("submit report");
  });

  it("extracts multi-word deadline date with keyword", () => {
    const result = extractDeadline("finish project deadline next friday");
    expect(result.deadlineText).toBe("next friday");
    expect(result.text).toBe("finish project");
  });

  it("extracts multi-word deadline date with !! prefix", () => {
    const result = extractDeadline("finish project !!next friday");
    expect(result.deadlineText).toBe("next friday");
    expect(result.text).toBe("finish project");
  });

  it("is case-insensitive for keyword", () => {
    const result = extractDeadline("submit report Deadline Friday");
    expect(result.deadlineText).toBe("Friday");
    expect(result.text).toBe("submit report");
  });

  it("stops before priority token", () => {
    const result = extractDeadline("submit report deadline friday p1");
    expect(result.deadlineText).toBe("friday");
    expect(result.text).toBe("submit report p1");
  });

  it("stops before tag token", () => {
    const result = extractDeadline("submit report deadline friday #work");
    expect(result.deadlineText).toBe("friday");
    expect(result.text).toBe("submit report #work");
  });

  it("returns null when no deadline present", () => {
    const result = extractDeadline("buy milk tomorrow");
    expect(result.deadlineText).toBeNull();
    expect(result.text).toBe("buy milk tomorrow");
  });
});

describe("extractDuration", () => {
  it("extracts ~30m", () => {
    const result = extractDuration("write report ~30m");
    expect(result.estimatedMinutes).toBe(30);
    expect(result.text).toBe("write report");
  });

  it("extracts ~1h", () => {
    const result = extractDuration("meeting ~1h");
    expect(result.estimatedMinutes).toBe(60);
    expect(result.text).toBe("meeting");
  });

  it("extracts ~1.5h", () => {
    const result = extractDuration("deep work ~1.5h");
    expect(result.estimatedMinutes).toBe(90);
    expect(result.text).toBe("deep work");
  });

  it("extracts compound ~1h30m", () => {
    const result = extractDuration("project planning ~1h30m");
    expect(result.estimatedMinutes).toBe(90);
    expect(result.text).toBe("project planning");
  });

  it("extracts ~2h15m", () => {
    const result = extractDuration("workshop ~2h15m");
    expect(result.estimatedMinutes).toBe(135);
    expect(result.text).toBe("workshop");
  });

  it("returns null when no duration present", () => {
    const result = extractDuration("buy milk");
    expect(result.estimatedMinutes).toBeNull();
    expect(result.text).toBe("buy milk");
  });

  it("does not match without ~ prefix", () => {
    const result = extractDuration("took 30m to arrive");
    expect(result.estimatedMinutes).toBeNull();
    expect(result.text).toBe("took 30m to arrive");
  });

  it("handles duration at the beginning", () => {
    const result = extractDuration("~45m code review");
    expect(result.estimatedMinutes).toBe(45);
    expect(result.text).toBe("code review");
  });
});
