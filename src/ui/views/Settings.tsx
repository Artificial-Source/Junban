import { useState, useEffect, useCallback } from "react";
import { themeManager } from "../themes/manager.js";
import { usePluginContext } from "../context/PluginContext.js";
import { api, type PluginInfo, type SettingDefinitionInfo } from "../api.js";

export function Settings() {
  const [currentTheme, setCurrentTheme] = useState(themeManager.getCurrent());
  const { plugins } = usePluginContext();
  const [expandedPlugin, setExpandedPlugin] = useState<string | null>(null);

  const handleThemeChange = (themeId: string) => {
    themeManager.setTheme(themeId);
    setCurrentTheme(themeId);
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Settings</h1>

      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-3">Appearance</h2>
        <div className="flex gap-3">
          <button
            onClick={() => handleThemeChange("light")}
            className={`px-4 py-2 rounded-lg border ${
              currentTheme === "light"
                ? "border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium"
                : "border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
            }`}
          >
            Light
          </button>
          <button
            onClick={() => handleThemeChange("dark")}
            className={`px-4 py-2 rounded-lg border ${
              currentTheme === "dark"
                ? "border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium"
                : "border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
            }`}
          >
            Dark
          </button>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-3">Plugins</h2>
        {plugins.length === 0 ? (
          <p className="text-gray-500">No plugins installed.</p>
        ) : (
          <div className="space-y-3">
            {plugins.map((plugin) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                expanded={expandedPlugin === plugin.id}
                onToggleExpand={() =>
                  setExpandedPlugin(expandedPlugin === plugin.id ? null : plugin.id)
                }
              />
            ))}
          </div>
        )}
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-3">Keyboard Shortcuts</h2>
        <p className="text-gray-500">Shortcut customization coming soon.</p>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Data</h2>
        <p className="text-gray-500">Data management coming soon.</p>
      </section>
    </div>
  );
}

function PluginCard({
  plugin,
  expanded,
  onToggleExpand,
}: {
  plugin: PluginInfo;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <button
        onClick={onToggleExpand}
        className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-800"
      >
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{plugin.name}</span>
            <span className="text-xs text-gray-400">v{plugin.version}</span>
            <span
              className={`text-xs px-1.5 py-0.5 rounded ${
                plugin.enabled
                  ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400"
                  : "bg-gray-100 dark:bg-gray-800 text-gray-500"
              }`}
            >
              {plugin.enabled ? "Active" : "Inactive"}
            </span>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            by {plugin.author} — {plugin.description}
          </p>
        </div>
        <span className="text-gray-400 text-sm">{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && plugin.settings.length > 0 && (
        <PluginSettings pluginId={plugin.id} definitions={plugin.settings} />
      )}

      {expanded && plugin.settings.length === 0 && (
        <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700">
          <p className="text-xs text-gray-400">No configurable settings.</p>
        </div>
      )}
    </div>
  );
}

function PluginSettings({
  pluginId,
  definitions,
}: {
  pluginId: string;
  definitions: SettingDefinitionInfo[];
}) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [loaded, setLoaded] = useState(false);

  const loadSettings = useCallback(async () => {
    try {
      const data = await api.getPluginSettings(pluginId);
      setValues(data);
      setLoaded(true);
    } catch {
      // Non-critical
    }
  }, [pluginId]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleChange = async (key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    await api.updatePluginSetting(pluginId, key, value);
  };

  if (!loaded) {
    return (
      <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700">
        <p className="text-xs text-gray-400">Loading settings...</p>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 space-y-3">
      {definitions.map((def) => (
        <SettingField
          key={def.id}
          definition={def}
          value={values[def.id] ?? def.default}
          onChange={(v) => handleChange(def.id, v)}
        />
      ))}
    </div>
  );
}

function SettingField({
  definition,
  value,
  onChange,
}: {
  definition: SettingDefinitionInfo;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
        {definition.name}
        {definition.description && (
          <span className="font-normal text-gray-400 ml-1">— {definition.description}</span>
        )}
      </label>
      {definition.type === "text" && (
        <input
          type="text"
          value={String(value ?? "")}
          placeholder={definition.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
        />
      )}
      {definition.type === "number" && (
        <input
          type="number"
          value={Number(value ?? 0)}
          min={definition.min}
          max={definition.max}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-24 px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
        />
      )}
      {definition.type === "boolean" && (
        <button
          onClick={() => onChange(!value)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            value ? "bg-blue-500" : "bg-gray-300 dark:bg-gray-600"
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
              value ? "translate-x-4.5" : "translate-x-0.5"
            }`}
          />
        </button>
      )}
      {definition.type === "select" && (
        <select
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          className="px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
        >
          {definition.options?.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
