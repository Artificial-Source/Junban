import { useState, useEffect } from "react";
import { api } from "../../../api/index.js";

export function DailyBriefingSection() {
  const [enabled, setEnabled] = useState(false);
  const [energy, setEnergy] = useState("medium");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all([api.getAppSetting("ai_daily_briefing"), api.getAppSetting("ai_default_energy")])
      .then(([briefing, energyVal]) => {
        if (briefing === "on") setEnabled(true);
        if (energyVal) setEnergy(energyVal);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const handleToggle = async (checked: boolean) => {
    setEnabled(checked);
    await api.setAppSetting("ai_daily_briefing", checked ? "on" : "off");
  };

  const handleEnergyChange = async (value: string) => {
    setEnergy(value);
    await api.setAppSetting("ai_default_energy", value);
  };

  if (!loaded) return null;

  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold mb-1 text-on-surface">Daily Briefing</h2>
      <p className="text-xs text-on-surface-muted mb-3">
        Automatically start your morning with a day plan when you open the AI chat.
      </p>
      <div className="space-y-3 max-w-md">
        <label className="flex items-center gap-2 text-sm text-on-surface">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => handleToggle(e.target.checked)}
            className="accent-accent"
          />
          Auto-show morning briefing
          <span className="text-xs text-on-surface-muted">(5am-12pm)</span>
        </label>

        <div>
          <label className="block text-xs font-medium text-on-surface-secondary mb-1">
            Default energy level
          </label>
          <select
            value={energy}
            onChange={(e) => handleEnergyChange(e.target.value)}
            className="px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
      </div>
    </section>
  );
}
