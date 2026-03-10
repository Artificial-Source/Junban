import { useState, useEffect } from "react";
import { api } from "../../../../ui/api/index.js";

export function CustomInstructionsSection() {
  const [instructions, setInstructions] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api
      .getAppSetting("ai_custom_instructions")
      .then((val) => {
        if (val) setInstructions(val);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const handleSave = async () => {
    await api.setAppSetting("ai_custom_instructions", instructions.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (!loaded) return null;

  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold mb-1 text-on-surface">Custom Instructions</h2>
      <p className="text-xs text-on-surface-muted mb-3">
        Add instructions the AI will always follow. These are injected into every conversation.
      </p>
      <textarea
        value={instructions}
        onChange={(e) => {
          setSaved(false);
          setInstructions(e.target.value.slice(0, 2000));
        }}
        placeholder="e.g., 'Always suggest time estimates', 'You're a project manager for a software team', 'Respond in Spanish'"
        rows={4}
        className="w-full max-w-lg px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface resize-none"
      />
      <div className="flex items-center gap-3 mt-2">
        <button
          onClick={handleSave}
          className="px-3 py-1.5 text-xs bg-accent text-white rounded-lg hover:bg-accent-hover"
        >
          Save
        </button>
        <span className="text-xs text-on-surface-muted">{instructions.length}/2000</span>
        {saved && <span className="text-xs text-success">Saved</span>}
      </div>
    </section>
  );
}
