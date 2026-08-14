/**
 * Confirmed settings saves through WorkspaceContext.
 * Appearance/runtime consumers only see server-confirmed snapshots.
 */
import { useCallback, useState } from "react";
import { ApiError, type PatchSettingsRequest } from "../../api/client";
import { useWorkspace } from "../../context/WorkspaceContext";

export function useSettingsSave() {
  const { settings, settingsLoading, settingsError, refreshSettings, saveSettings } =
    useWorkspace();
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const savePatch = useCallback(
    async (key: string, patch: PatchSettingsRequest): Promise<boolean> => {
      if (savingKey) return false;
      setSavingKey(key);
      setError(null);
      setFieldErrors({});
      try {
        await saveSettings(patch);
        return true;
      } catch (err) {
        if (err instanceof ApiError) {
          setError(err.message);
          if (err.fields) setFieldErrors(err.fields);
        } else {
          setError(err instanceof Error ? err.message : "Could not save settings");
        }
        return false;
      } finally {
        setSavingKey(null);
      }
    },
    [saveSettings, savingKey],
  );

  const clearError = useCallback(() => {
    setError(null);
    setFieldErrors({});
  }, []);

  return {
    settings,
    settingsLoading,
    settingsError,
    refreshSettings,
    savingKey,
    error,
    fieldErrors,
    savePatch,
    clearError,
    isSaving: (key?: string) => (key ? savingKey === key : savingKey !== null),
  };
}
