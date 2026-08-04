/**
 * Voice Settings local-model controller.
 *
 * Dynamically imports voice/local only after the Voice tab mounts. Inspects
 * verified cache status without workers/network. Consent Load downloads through
 * exact downloadLocalEnginePackage; Remove clears one package and matching
 * selection. No model worker is created here.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  isLocalSttPackageId,
  isLocalTtsPackageId,
  readLocalVoicePreferences,
  subscribeLocalVoicePreferences,
  writeLocalVoicePreferences,
  type LocalSttPreference,
  type LocalTtsPreference,
  type LocalVoicePreferences,
} from "../../../voice/localPreferences";
import type { LocalModelController, LocalModelVerifiedStatus } from "./LocalModelCard";

export type LocalModelLoadProgress = {
  packageId: string;
  loaded: number;
  total: number;
};

export type UseLocalModelControllerResult = LocalModelController & {
  preferences: LocalVoicePreferences;
  statuses: Readonly<Record<string, LocalModelVerifiedStatus>>;
  busyPackageId: string | null;
  progress: LocalModelLoadProgress | null;
  error: string | null;
  clearError: () => void;
  selectStt: (value: LocalSttPreference) => void;
  selectTts: (value: LocalTtsPreference) => void;
  ready: boolean;
};

type LocalModule = typeof import("../../../voice/local/index");

const SAFE_LOAD_ERROR = "Could not download or verify the local model.";
const SAFE_REMOVE_ERROR = "Could not remove the local model.";
const SAFE_STATUS_ERROR = "Could not read local model status.";

export function useLocalModelController(): UseLocalModelControllerResult {
  const preferences = useSyncExternalStore(
    subscribeLocalVoicePreferences,
    readLocalVoicePreferences,
    readLocalVoicePreferences,
  );

  const [statuses, setStatuses] = useState<Record<string, LocalModelVerifiedStatus>>({});
  const [busyPackageId, setBusyPackageId] = useState<string | null>(null);
  const [progress, setProgress] = useState<LocalModelLoadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moduleReady, setModuleReady] = useState(false);

  const localModRef = useRef<LocalModule | null>(null);
  const mountedRef = useRef(true);
  const refreshGen = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const mod = await import("../../../voice/local/index");
        if (cancelled || !mountedRef.current) return;
        localModRef.current = mod;
        setModuleReady(true);
      } catch {
        if (!cancelled && mountedRef.current) {
          setError(SAFE_STATUS_ERROR);
        }
      }
    })();
    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, []);

  const refreshStatuses = useCallback(async () => {
    const mod = localModRef.current;
    if (!mod) return;
    const gen = ++refreshGen.current;
    try {
      const all = await mod.getAllLocalEngineStatuses();
      if (!mountedRef.current || gen !== refreshGen.current) return;
      const next: Record<string, LocalModelVerifiedStatus> = {};
      for (const status of all) {
        next[status.packageId] = status.verified ? "ready" : "not_loaded";
      }
      setStatuses(next);
    } catch {
      if (mountedRef.current && gen === refreshGen.current) {
        setError(SAFE_STATUS_ERROR);
      }
    }
  }, []);

  useEffect(() => {
    if (!moduleReady) return;
    void refreshStatuses();
  }, [moduleReady, refreshStatuses]);

  const selectStt = useCallback(
    (value: LocalSttPreference) => {
      writeLocalVoicePreferences({ ...preferences, stt: value });
    },
    [preferences],
  );

  const selectTts = useCallback(
    (value: LocalTtsPreference) => {
      writeLocalVoicePreferences({ ...preferences, tts: value });
    },
    [preferences],
  );

  const getStatus = useCallback(
    (packageId: string): LocalModelVerifiedStatus => statuses[packageId] ?? "not_loaded",
    [statuses],
  );

  const onConsentLoad = useCallback(
    async (packageId: string) => {
      const mod = localModRef.current;
      if (!mod || busyPackageId) return;
      setError(null);
      setBusyPackageId(packageId);
      setProgress({ packageId, loaded: 0, total: 0 });
      try {
        await mod.downloadLocalEnginePackage(packageId, {
          onProgress: (p) => {
            if (!mountedRef.current) return;
            setProgress({
              packageId: p.packageId,
              loaded: p.loaded,
              total: p.total,
            });
          },
        });
        if (!mountedRef.current) return;
        // Consent Load may select the package — user clicked source/license/size/hash.
        if (isLocalSttPackageId(packageId)) {
          writeLocalVoicePreferences({ ...readLocalVoicePreferences(), stt: packageId });
        } else if (isLocalTtsPackageId(packageId)) {
          writeLocalVoicePreferences({ ...readLocalVoicePreferences(), tts: packageId });
        }
        await refreshStatuses();
      } catch {
        if (mountedRef.current) setError(SAFE_LOAD_ERROR);
        await refreshStatuses();
      } finally {
        if (mountedRef.current) {
          setBusyPackageId(null);
          setProgress(null);
        }
      }
    },
    [busyPackageId, refreshStatuses],
  );

  const onRemove = useCallback(
    async (packageId: string) => {
      const mod = localModRef.current;
      if (!mod || busyPackageId) return;
      setError(null);
      setBusyPackageId(packageId);
      try {
        await mod.removeLocalEnginePackage(packageId);
        if (!mountedRef.current) return;
        const current = readLocalVoicePreferences();
        let next = current;
        if (current.stt === packageId) {
          next = { ...next, stt: "browser" };
        }
        if (current.tts === packageId) {
          next = { ...next, tts: "browser" };
        }
        if (next !== current) {
          writeLocalVoicePreferences(next);
        }
        await refreshStatuses();
      } catch {
        if (mountedRef.current) setError(SAFE_REMOVE_ERROR);
        await refreshStatuses();
      } finally {
        if (mountedRef.current) setBusyPackageId(null);
      }
    },
    [busyPackageId, refreshStatuses],
  );

  const isSelected = useCallback(
    (packageId: string): boolean => preferences.stt === packageId || preferences.tts === packageId,
    [preferences],
  );

  const onSelect = useCallback(
    (packageId: string) => {
      if (isLocalSttPackageId(packageId)) {
        selectStt(packageId);
        return;
      }
      if (isLocalTtsPackageId(packageId)) {
        selectTts(packageId);
      }
    },
    [selectStt, selectTts],
  );

  return useMemo(
    () => ({
      preferences,
      statuses,
      busyPackageId,
      progress,
      error,
      clearError: () => setError(null),
      selectStt,
      selectTts,
      ready: moduleReady,
      getStatus,
      onConsentLoad,
      onRemove,
      isSelected,
      onSelect,
      progressFor: (packageId: string) => (progress?.packageId === packageId ? progress : null),
      busy: Boolean(busyPackageId),
    }),
    [
      preferences,
      statuses,
      busyPackageId,
      progress,
      error,
      selectStt,
      selectTts,
      moduleReady,
      getStatus,
      onConsentLoad,
      onRemove,
      isSelected,
      onSelect,
    ],
  );
}
