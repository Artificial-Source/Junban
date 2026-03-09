import { useState, useEffect, useCallback, useRef } from "react";
import { Play, Square, Clock } from "lucide-react";
import type { TimeBlock } from "../types.js";
import { timeToMinutes } from "./TimelineColumn.js";

interface FocusTimerProps {
  block: TimeBlock;
  onComplete?: () => void;
  onStatusUpdate?: (status: string) => void;
}

function formatRemaining(minutes: number): string {
  if (minutes <= 0) return "0m";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function isBlockActive(block: TimeBlock): boolean {
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (block.date !== todayStr) return false;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return nowMinutes >= timeToMinutes(block.startTime) && nowMinutes < timeToMinutes(block.endTime);
}

export function FocusTimer({ block, onComplete, onStatusUpdate }: FocusTimerProps) {
  const [focusing, setFocusing] = useState(false);
  const [remainingMinutes, setRemainingMinutes] = useState(0);
  const [completed, setCompleted] = useState(false);
  const completedRef = useRef(false);
  const active = isBlockActive(block);

  // Calculate remaining time
  const updateRemaining = useCallback(() => {
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const endMinutes = timeToMinutes(block.endTime);
    const remaining = Math.max(0, endMinutes - nowMinutes);
    setRemainingMinutes(remaining);

    if (remaining <= 0 && focusing && !completedRef.current) {
      completedRef.current = true;
      setCompleted(true);
      setFocusing(false);
      onComplete?.();
      onStatusUpdate?.("");
    }

    return remaining;
  }, [block.endTime, focusing, onComplete, onStatusUpdate]);

  // Timer tick
  useEffect(() => {
    if (!focusing) return;
    updateRemaining();
    const timer = setInterval(updateRemaining, 10000); // Update every 10 seconds
    return () => clearInterval(timer);
  }, [focusing, updateRemaining]);

  // Update status bar
  useEffect(() => {
    if (focusing && remainingMinutes > 0) {
      onStatusUpdate?.(`📅 Focus: ${block.title} (${formatRemaining(remainingMinutes)} left)`);
    }
  }, [focusing, remainingMinutes, block.title, onStatusUpdate]);

  const handleStartFocus = useCallback(() => {
    completedRef.current = false;
    setCompleted(false);
    setFocusing(true);
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const endMinutes = timeToMinutes(block.endTime);
    setRemainingMinutes(Math.max(0, endMinutes - nowMinutes));
  }, [block.endTime]);

  const handleStopFocus = useCallback(() => {
    setFocusing(false);
    onStatusUpdate?.("");
  }, [onStatusUpdate]);

  if (completed) {
    return (
      <div
        className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-success/10 text-success text-xs font-medium"
        data-testid="focus-complete"
      >
        <Clock size={12} />
        <span>Time block complete!</span>
      </div>
    );
  }

  if (focusing) {
    return (
      <div className="flex items-center gap-2" data-testid="focus-active">
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-accent/10 text-accent text-xs font-medium animate-pulse">
          <Clock size={12} />
          <span>{formatRemaining(remainingMinutes)} remaining</span>
        </div>
        <button
          onClick={handleStopFocus}
          className="p-1 rounded hover:bg-surface-secondary text-on-surface-muted transition-colors"
          aria-label="Stop focus"
          data-testid="focus-stop"
        >
          <Square size={12} />
        </button>
      </div>
    );
  }

  if (!active) return null;

  return (
    <button
      onClick={handleStartFocus}
      className="flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
      data-testid="focus-start"
    >
      <Play size={12} />
      <span>Focus</span>
    </button>
  );
}

export { isBlockActive, formatRemaining };
