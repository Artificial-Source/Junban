import { Plugin } from "../../src/plugins/lifecycle.js";

type TimerState = "idle" | "running" | "paused" | "break";
type Phase = "work" | "break" | "longBreak";

export default class PomodoroPlugin extends Plugin {
  private state: TimerState = "idle";
  private phase: Phase = "work";
  private timeLeft = 0;
  private session = 1;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private statusHandle: { update: (data: { text?: string; icon?: string }) => void } | null = null;

  async onLoad() {
    this.timeLeft = this.getWorkSeconds();

    // Register commands
    this.app.commands?.register({
      id: "start",
      name: "Pomodoro: Start",
      callback: () => this.start(),
    });

    this.app.commands?.register({
      id: "pause",
      name: "Pomodoro: Pause",
      callback: () => this.pause(),
    });

    this.app.commands?.register({
      id: "reset",
      name: "Pomodoro: Reset",
      callback: () => this.reset(),
    });

    this.app.commands?.register({
      id: "skip",
      name: "Pomodoro: Skip",
      callback: () => this.skip(),
    });

    // Status bar
    this.statusHandle = this.app.ui.addStatusBarItem?.({
      id: "pomodoro-timer",
      text: "Ready",
      icon: "\uD83C\uDF45",
    }) ?? null;

    // Sidebar panel
    this.app.ui.addSidebarPanel?.({
      id: "pomodoro-panel",
      title: "Pomodoro",
      icon: "\uD83C\uDF45",
      render: () => this.getPanelContent(),
    });
  }

  async onUnload() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.statusHandle = null;
  }

  private start() {
    if (this.state === "running") return;

    if (this.state === "idle") {
      this.timeLeft = this.getPhaseSeconds();
    }

    this.state = "running";
    this.intervalId = setInterval(() => this.tick(), 1000);
    this.updateUI();
  }

  private pause() {
    if (this.state !== "running") return;

    this.state = "paused";
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.updateUI();
  }

  private reset() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.timeLeft = this.getPhaseSeconds();
    this.state = "idle";
    this.updateUI();
  }

  private skip() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.advancePhase();
    this.state = "idle";
    this.updateUI();
  }

  private tick() {
    this.timeLeft--;
    if (this.timeLeft <= 0) {
      this.advancePhase();
      // Auto-start next phase
      this.timeLeft = this.getPhaseSeconds();
    }
    this.updateUI();
  }

  private advancePhase() {
    if (this.phase === "work") {
      const sessionsBeforeLong = this.settings.get<number>("sessionsBeforeLongBreak");
      if (this.session >= sessionsBeforeLong) {
        this.phase = "longBreak";
        this.session = 1;
      } else {
        this.phase = "break";
        this.session++;
      }
    } else {
      this.phase = "work";
    }
    this.timeLeft = this.getPhaseSeconds();
  }

  private getWorkSeconds(): number {
    return this.settings.get<number>("workMinutes") * 60;
  }

  private getPhaseSeconds(): number {
    switch (this.phase) {
      case "work":
        return this.settings.get<number>("workMinutes") * 60;
      case "break":
        return this.settings.get<number>("breakMinutes") * 60;
      case "longBreak":
        return this.settings.get<number>("longBreakMinutes") * 60;
    }
  }

  private formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }

  private getPhaseLabel(): string {
    switch (this.phase) {
      case "work":
        return "Work";
      case "break":
        return "Break";
      case "longBreak":
        return "Long Break";
    }
  }

  private updateUI() {
    const time = this.formatTime(this.timeLeft);

    // Update status bar
    if (this.state === "idle") {
      this.statusHandle?.update({ text: "Ready" });
    } else if (this.state === "paused") {
      this.statusHandle?.update({ text: `${time} (paused)` });
    } else {
      this.statusHandle?.update({ text: time });
    }
  }

  private getPanelContent(): string {
    const time = this.formatTime(this.timeLeft);
    const phaseLabel = this.getPhaseLabel();
    const sessionsBeforeLong = this.settings.get<number>("sessionsBeforeLongBreak");

    const lines = [
      `Phase: ${phaseLabel}`,
      `Time: ${time}`,
      `Session: ${this.session}/${sessionsBeforeLong}`,
      `Status: ${this.state}`,
    ];

    return lines.join("\n");
  }
}
