import { Circle, CheckCircle2, XCircle } from "lucide-react";

export const PRIORITIES = [
  { value: 1, label: "P1", activeClass: "bg-priority-1/15 text-priority-1" },
  { value: 2, label: "P2", activeClass: "bg-priority-2/15 text-priority-2" },
  { value: 3, label: "P3", activeClass: "bg-priority-3/15 text-priority-3" },
  { value: 4, label: "P4", activeClass: "bg-priority-4/15 text-priority-4" },
];

export const STATUS_OPTIONS = [
  { value: "pending" as const, label: "Pending", icon: Circle, color: "text-on-surface-muted" },
  {
    value: "completed" as const,
    label: "Completed",
    icon: CheckCircle2,
    color: "text-success",
  },
  { value: "cancelled" as const, label: "Cancelled", icon: XCircle, color: "text-error" },
];
