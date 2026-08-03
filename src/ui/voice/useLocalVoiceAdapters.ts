/**
 * Lazy local STT/TTS adapter integration for the AI chat route.
 *
 * Production module has no static import of local index/engines/workers.
 * Dynamic import runs only when confirmed provider is browser and an explicit
 * local preference selects a package. Cloud confirmed never constructs local.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isCloudStt, isCloudTts } from "./voice-capabilities";
import {
  isLocalSttPackageId,
  isLocalTtsPackageId,
  readLocalVoicePreferences,
  subscribeLocalVoicePreferences,
  type LocalSttPackageId,
  type LocalTtsPackageId,
  type LocalVoicePreferences,
} from "./localPreferences";
import type {
  ConfirmedVoiceSettings,
  LocalAdapterStatus,
  LocalSttAdapter,
  LocalTtsAdapter,
} from "./types";

export type UseLocalVoiceAdaptersOptions = {
  settings: ConfirmedVoiceSettings | null | undefined;
  /** When false, adapters are disposed and not constructed (fixtures). */
  enabled?: boolean;
};

export type UseLocalVoiceAdaptersResult = {
  localStt: LocalSttAdapter | null;
  localTts: LocalTtsAdapter | null;
  sttStatus: LocalAdapterStatus | null;
  ttsStatus: LocalAdapterStatus | null;
};

type AdapterModule = typeof import("./local-adapters");

function useLocalVoicePreferenceStore(): LocalVoicePreferences {
  return useSyncExternalStore(
    subscribeLocalVoicePreferences,
    readLocalVoicePreferences,
    readLocalVoicePreferences,
  );
}

type SttBridge = {
  packageId: LocalSttPackageId;
  status: LocalAdapterStatus;
  transcribe: LocalSttAdapter["transcribe"];
  dispose: () => void;
};

type TtsBridge = {
  packageId: LocalTtsPackageId;
  status: LocalAdapterStatus;
  speak: LocalTtsAdapter["speak"];
  cancel: () => void;
  dispose: () => void;
};

export function useLocalVoiceAdapters(
  options: UseLocalVoiceAdaptersOptions,
): UseLocalVoiceAdaptersResult {
  const { settings, enabled = true } = options;
  const prefs = useLocalVoicePreferenceStore();

  const wantSttPackage =
    enabled &&
    settings &&
    settings.stt_provider === "browser" &&
    !isCloudStt(settings) &&
    isLocalSttPackageId(prefs.stt)
      ? prefs.stt
      : null;

  const wantTtsPackage =
    enabled &&
    settings &&
    settings.tts_enabled &&
    settings.tts_provider === "browser" &&
    !isCloudTts(settings) &&
    isLocalTtsPackageId(prefs.tts)
      ? prefs.tts
      : null;

  const [sttStatus, setSttStatus] = useState<LocalAdapterStatus | null>(
    wantSttPackage ? "loading" : null,
  );
  const [ttsStatus, setTtsStatus] = useState<LocalAdapterStatus | null>(
    wantTtsPackage ? "loading" : null,
  );

  const sttRef = useRef<SttBridge | null>(null);
  const ttsRef = useRef<TtsBridge | null>(null);
  const genRef = useRef(0);

  // One effect owns both adapters so a single dynamic import serves both.
  useEffect(() => {
    const gen = ++genRef.current;

    // Dispose previous owners before replacing.
    sttRef.current?.dispose();
    ttsRef.current?.dispose();
    sttRef.current = null;
    ttsRef.current = null;

    setSttStatus(wantSttPackage ? "loading" : null);
    setTtsStatus(wantTtsPackage ? "loading" : null);

    if (!wantSttPackage && !wantTtsPackage) {
      return () => {
        genRef.current += 1;
      };
    }

    let cancelled = false;

    void (async () => {
      let mod: AdapterModule;
      try {
        mod = await import("./local-adapters");
      } catch {
        if (cancelled || gen !== genRef.current) return;
        if (wantSttPackage) setSttStatus("error");
        if (wantTtsPackage) setTtsStatus("error");
        return;
      }
      if (cancelled || gen !== genRef.current) return;

      if (wantSttPackage) {
        const owner = mod.createLocalWhisperAdapter({
          packageId: wantSttPackage,
          onStatus: (status) => {
            if (cancelled || gen !== genRef.current) return;
            if (sttRef.current) sttRef.current.status = status;
            setSttStatus(status);
          },
        });
        sttRef.current = {
          packageId: wantSttPackage,
          status: owner.status,
          transcribe: (audio, opts) => owner.transcribe(audio, opts),
          dispose: () => owner.dispose(),
        };
        setSttStatus(owner.status);
        void owner.prepare().then(() => {
          if (cancelled || gen !== genRef.current) {
            owner.dispose();
            return;
          }
          if (sttRef.current) sttRef.current.status = owner.status;
          setSttStatus(owner.status);
        });
      }

      if (wantTtsPackage) {
        const owner = mod.createLocalTtsAdapter({
          packageId: wantTtsPackage,
          onStatus: (status) => {
            if (cancelled || gen !== genRef.current) return;
            if (ttsRef.current) ttsRef.current.status = status;
            setTtsStatus(status);
          },
        });
        ttsRef.current = {
          packageId: wantTtsPackage,
          status: owner.status,
          speak: (text, opts) => owner.speak(text, opts),
          cancel: () => owner.cancel(),
          dispose: () => owner.dispose(),
        };
        setTtsStatus(owner.status);
        void owner.prepare().then(() => {
          if (cancelled || gen !== genRef.current) {
            owner.dispose();
            return;
          }
          if (ttsRef.current) ttsRef.current.status = owner.status;
          setTtsStatus(owner.status);
        });
      }
    })();

    return () => {
      cancelled = true;
      genRef.current += 1;
      sttRef.current?.dispose();
      ttsRef.current?.dispose();
      sttRef.current = null;
      ttsRef.current = null;
    };
  }, [wantSttPackage, wantTtsPackage]);

  return useMemo(() => {
    const sttBridge = sttRef.current;
    const ttsBridge = ttsRef.current;

    const localStt: LocalSttAdapter | null = wantSttPackage
      ? {
          get status() {
            return sttBridge?.status ?? sttStatus ?? "loading";
          },
          transcribe: (audio, opts) => {
            if (!sttBridge) {
              return Promise.reject(voiceErrorUnsupported());
            }
            return sttBridge.transcribe(audio, opts);
          },
          dispose: () => sttBridge?.dispose(),
        }
      : null;

    const localTts: LocalTtsAdapter | null = wantTtsPackage
      ? {
          get status() {
            return ttsBridge?.status ?? ttsStatus ?? "loading";
          },
          speak: (text, opts) => {
            if (!ttsBridge) {
              return Promise.reject(voiceErrorUnsupported());
            }
            return ttsBridge.speak(text, opts);
          },
          cancel: () => ttsBridge?.cancel(),
          dispose: () => ttsBridge?.dispose(),
        }
      : null;

    return {
      localStt,
      localTts,
      sttStatus: wantSttPackage ? (sttStatus ?? "loading") : null,
      ttsStatus: wantTtsPackage ? (ttsStatus ?? "loading") : null,
    };
  }, [wantSttPackage, wantTtsPackage, sttStatus, ttsStatus]);
}

function voiceErrorUnsupported(): Error {
  const error = new Error("Local speech model is not ready.");
  (error as Error & { code?: string }).code = "unsupported";
  return error;
}
