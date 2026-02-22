import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("lucide-react", () => ({
  ChevronDown: (props: any) => <svg data-testid="chevron-down" {...props} />,
  ChevronRight: (props: any) => <svg data-testid="chevron-right" {...props} />,
  CheckCircle2: (props: any) => <svg data-testid="check-circle" {...props} />,
  AlertTriangle: (props: any) => <svg data-testid="alert-icon" {...props} />,
  Clock: (props: any) => <svg data-testid="clock-icon" {...props} />,
  Zap: (props: any) => <svg data-testid="zap-icon" {...props} />,
  Brain: (props: any) => <svg data-testid="brain-icon" {...props} />,
  Tag: (props: any) => <svg data-testid="tag-icon" {...props} />,
  FolderOpen: (props: any) => <svg data-testid="folder-icon" {...props} />,
  BarChart3: (props: any) => <svg data-testid="chart-icon" {...props} />,
  Search: (props: any) => <svg data-testid="search-icon" {...props} />,
  Puzzle: (props: any) => <svg data-testid="puzzle-icon" {...props} />,
  Bell: (props: any) => <svg data-testid="bell-icon" {...props} />,
  Sun: (props: any) => <svg data-testid="sun-icon" {...props} />,
  Sunset: (props: any) => <svg data-testid="sunset-icon" {...props} />,
  Flame: (props: any) => <svg data-testid="flame-icon" {...props} />,
  ArrowRight: (props: any) => <svg data-testid="arrow-right" {...props} />,
}));

import { ChatToolResultCard } from "../../../../src/ui/components/chat/ChatToolResultCard.js";

describe("ChatToolResultCard", () => {
  it("renders workload chart", () => {
    const toolResults = [
      {
        toolName: "analyze_workload",
        data: JSON.stringify({
          days: [
            { date: "Mon", count: 5 },
            { date: "Tue", count: 3 },
          ],
        }),
      },
    ];
    render(<ChatToolResultCard toolResults={toolResults} />);
    expect(screen.getByText("Workload Overview")).toBeDefined();
    expect(screen.getByText("Mon")).toBeDefined();
    expect(screen.getByText("Tue")).toBeDefined();
  });

  it("renders tag suggestions", () => {
    const toolResults = [
      {
        toolName: "suggest_tags",
        data: JSON.stringify({ tags: ["frontend", "bug"] }),
      },
    ];
    render(<ChatToolResultCard toolResults={toolResults} />);
    expect(screen.getByText("Suggested Tags")).toBeDefined();
    expect(screen.getByText("frontend")).toBeDefined();
    expect(screen.getByText("bug")).toBeDefined();
  });

  it("renders task breakdown", () => {
    const toolResults = [
      {
        toolName: "break_down_task",
        data: JSON.stringify({
          parent: { title: "Big Task" },
          subtasks: [{ title: "Step 1" }, { title: "Step 2" }],
        }),
      },
    ];
    render(<ChatToolResultCard toolResults={toolResults} />);
    expect(screen.getByText("Task Breakdown")).toBeDefined();
    expect(screen.getByText("Big Task")).toBeDefined();
    expect(screen.getByText("Step 1")).toBeDefined();
    expect(screen.getByText("Step 2")).toBeDefined();
  });

  it("renders overcommitment status (all clear)", () => {
    const toolResults = [
      {
        toolName: "check_overcommitment",
        data: JSON.stringify({ overloaded: false, suggestion: "Looking good!" }),
      },
    ];
    render(<ChatToolResultCard toolResults={toolResults} />);
    expect(screen.getByText("All clear")).toBeDefined();
    expect(screen.getByText("Looking good!")).toBeDefined();
  });

  it("renders overcommitment status (overloaded)", () => {
    const toolResults = [
      {
        toolName: "check_overcommitment",
        data: JSON.stringify({ overloaded: true, suggestion: "Consider deferring tasks." }),
      },
    ];
    render(<ChatToolResultCard toolResults={toolResults} />);
    expect(screen.getByText("Overloaded")).toBeDefined();
  });

  it("renders task list card", () => {
    const toolResults = [
      {
        toolName: "query_tasks",
        data: JSON.stringify({
          tasks: [
            { id: "t1", title: "Task One", status: "pending" },
            { id: "t2", title: "Task Two", status: "completed" },
          ],
        }),
      },
    ];
    render(<ChatToolResultCard toolResults={toolResults} />);
    expect(screen.getByText("Task Results")).toBeDefined();
    expect(screen.getByText("Task One")).toBeDefined();
    expect(screen.getByText("Task Two")).toBeDefined();
  });

  it("skips non-JSON data gracefully", () => {
    const toolResults = [{ toolName: "analyze_workload", data: "not json" }];
    const { container } = render(<ChatToolResultCard toolResults={toolResults} />);
    // Should not crash, just render empty
    expect(container.querySelector(".space-y-2")).toBeDefined();
  });

  it("renders project list", () => {
    const toolResults = [
      {
        toolName: "list_projects",
        data: JSON.stringify({
          projects: [{ id: "p1", name: "Frontend", color: "#4073ff" }],
        }),
      },
    ];
    render(<ChatToolResultCard toolResults={toolResults} />);
    expect(screen.getByText("Projects")).toBeDefined();
    expect(screen.getByText("Frontend")).toBeDefined();
  });
});
