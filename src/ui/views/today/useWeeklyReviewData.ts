import { useCallback } from "react";
import { toDateKey } from "../../../utils/format-date.js";
import type { WeeklyReviewData } from "../../components/WeeklyReviewModal.js";
import type { Task, Project } from "../../../core/types.js";

/**
 * Hook that computes weekly review data from the client-side task list.
 * Returns a callback that calculates the data on demand.
 */
export function useWeeklyReviewData(
  tasks: Task[],
  projects: Project[],
): () => WeeklyReviewData {
  return useCallback(() => {
    const now = new Date();
    const day = now.getDay();
    const daysBack = day === 0 ? 6 : day - 1;
    const lastMonday = new Date(now);
    lastMonday.setDate(lastMonday.getDate() - (daysBack === 0 ? 7 : daysBack));
    const weekStartStr = toDateKey(lastMonday);
    const weekEndDate = new Date(lastMonday);
    weekEndDate.setDate(weekEndDate.getDate() + 6);
    const weekEndStr = toDateKey(weekEndDate);

    function inWeek(dateStr: string | null): boolean {
      if (!dateStr) return false;
      const d = dateStr.split("T")[0];
      return d >= weekStartStr && d <= weekEndStr;
    }

    const completedInWeek = tasks.filter((t) => t.status === "completed" && inWeek(t.completedAt));
    const createdInWeek = tasks.filter((t) => inWeek(t.createdAt));
    const cancelledInWeek = tasks.filter((t) => t.status === "cancelled" && inWeek(t.updatedAt));

    const totalActionable = completedInWeek.length + cancelledInWeek.length;
    const completionRate =
      totalActionable > 0 ? Math.round((completedInWeek.length / totalActionable) * 100) : 0;

    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const dailyStats = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(lastMonday);
      d.setDate(d.getDate() + i);
      const dStr = toDateKey(d);
      dailyStats.push({
        date: dStr,
        dayName: dayNames[d.getDay()],
        completed: completedInWeek.filter(
          (t) => t.completedAt && t.completedAt.split("T")[0] === dStr,
        ).length,
        created: createdInWeek.filter((t) => t.createdAt && t.createdAt.split("T")[0] === dStr)
          .length,
      });
    }

    const busiestDay = dailyStats.reduce(
      (best, d) => (d.completed > best.completed ? d : best),
      dailyStats[0],
    );

    const bucketCounts = { morning: 0, afternoon: 0, evening: 0, night: 0 };
    for (const t of completedInWeek) {
      if (t.completedAt) {
        const hour = new Date(t.completedAt).getHours();
        if (hour >= 5 && hour < 12) bucketCounts.morning++;
        else if (hour >= 12 && hour < 17) bucketCounts.afternoon++;
        else if (hour >= 17 && hour < 21) bucketCounts.evening++;
        else bucketCounts.night++;
      }
    }
    const productiveTime =
      completedInWeek.length > 0
        ? (Object.entries(bucketCounts).sort(([, a], [, b]) => b - a)[0][0] as string)
        : null;

    const todayStr = toDateKey(now);
    const overdueList = tasks
      .filter((t) => t.status === "pending" && t.dueDate && t.dueDate.split("T")[0] < todayStr)
      .sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5));

    // Streak
    const completedAll = tasks.filter((t) => t.status === "completed");
    let streakDays = 0;
    for (let i = 0; i < 30; i++) {
      const d = new Date(todayStr + "T00:00:00");
      d.setDate(d.getDate() - i);
      const dStr = toDateKey(d);
      const has = completedAll.some((t) => t.completedAt && t.completedAt.split("T")[0] === dStr);
      if (has) streakDays++;
      else if (i > 0) break;
    }

    const topAccomplishments = completedInWeek
      .sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5))
      .slice(0, 5)
      .map((t) => ({
        id: t.id,
        title: t.title.length > 60 ? t.title.slice(0, 57) + "..." : t.title,
        priority: t.priority,
        completedAt: t.completedAt,
        projectId: t.projectId,
      }));

    // Neglected projects
    const neglectedProjects: { id: string; name: string; overdueCount: number; reason: string }[] =
      [];
    for (const project of projects) {
      const pTasks = tasks.filter((t) => t.projectId === project.id);
      const pOverdue = pTasks.filter(
        (t) => t.status === "pending" && t.dueDate && t.dueDate.split("T")[0] < todayStr,
      );
      const hadActivity =
        pTasks.some((t) => inWeek(t.completedAt)) || pTasks.some((t) => inWeek(t.createdAt));
      if (pOverdue.length > 0) {
        neglectedProjects.push({
          id: project.id,
          name: project.name,
          overdueCount: pOverdue.length,
          reason: `${pOverdue.length} overdue task${pOverdue.length > 1 ? "s" : ""}`,
        });
      } else if (!hadActivity && pTasks.some((t) => t.status === "pending")) {
        neglectedProjects.push({
          id: project.id,
          name: project.name,
          overdueCount: 0,
          reason: "No activity this week",
        });
      }
    }

    // Suggestions
    const suggestions: string[] = [];
    if (overdueList.length > 0) {
      suggestions.push(
        `Tackle your ${overdueList.length} overdue task${overdueList.length > 1 ? "s" : ""} early in the week.`,
      );
    }
    if (neglectedProjects.length > 0) {
      suggestions.push(
        `Check in on neglected projects: ${neglectedProjects
          .slice(0, 3)
          .map((p) => p.name)
          .join(", ")}.`,
      );
    }
    if (createdInWeek.length > completedInWeek.length && createdInWeek.length > 0) {
      suggestions.push(
        "You created more tasks than you completed — consider being more selective.",
      );
    }
    if (streakDays > 0) {
      suggestions.push(`Keep your ${streakDays}-day streak going!`);
    }

    return {
      weekStartDate: weekStartStr,
      weekEndDate: weekEndStr,
      completionRate,
      taskFlow: {
        created: createdInWeek.length,
        completed: completedInWeek.length,
        cancelled: cancelledInWeek.length,
        net: completedInWeek.length - createdInWeek.length,
      },
      dailyStats,
      busiestDay: busiestDay
        ? { date: busiestDay.date, dayName: busiestDay.dayName, completed: busiestDay.completed }
        : null,
      productiveTime,
      productiveTimeCounts: bucketCounts,
      neglectedProjects: neglectedProjects.slice(0, 10),
      overdue: {
        count: overdueList.length,
        tasks: overdueList.slice(0, 10).map((t) => ({
          id: t.id,
          title: t.title.length > 60 ? t.title.slice(0, 57) + "..." : t.title,
          priority: t.priority,
          dueDate: t.dueDate,
        })),
      },
      streak: { currentDays: streakDays, isActive: streakDays > 0 },
      topAccomplishments,
      suggestions: suggestions.slice(0, 4),
    };
  }, [tasks, projects]);
}
