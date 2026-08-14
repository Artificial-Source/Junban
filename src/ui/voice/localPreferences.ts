/**
 * Browser-local, non-secret local-model preference authority.
 *
 * Persists only explicit STT/TTS model consent/selection. Invalid or stale
 * package IDs fail closed to Browser on parse. Runtime local failures must not
 * rewrite these preferences.
 */

export const LOCAL_VOICE_PREFERENCES_STORAGE_KEY = "junban.voice.local.v1";

/** Same-origin event so Settings and mounted chat reconcile without storage races. */
export const LOCAL_VOICE_PREFERENCES_EVENT = "junban-voice-local-preferences";

/** Hard ceiling for the serialized preference document. */
export const LOCAL_VOICE_PREFERENCES_MAX_BYTES = 512;

export const LOCAL_STT_PACKAGE_IDS = ["whisper-tiny.en-q4"] as const;
export const LOCAL_TTS_PACKAGE_IDS = ["kokoro-82m-v1-q8", "piper-en_US-ljspeech-medium"] as const;

export type LocalSttPackageId = (typeof LOCAL_STT_PACKAGE_IDS)[number];
export type LocalTtsPackageId = (typeof LOCAL_TTS_PACKAGE_IDS)[number];

export type LocalSttPreference = "browser" | LocalSttPackageId;
export type LocalTtsPreference = "browser" | LocalTtsPackageId;

export type LocalVoicePreferences = {
  version: 1;
  stt: LocalSttPreference;
  tts: LocalTtsPreference;
};

const DEFAULT_PREFS: LocalVoicePreferences = {
  version: 1,
  stt: "browser",
  tts: "browser",
};

const STT_SET = new Set<string>(["browser", ...LOCAL_STT_PACKAGE_IDS]);
const TTS_SET = new Set<string>(["browser", ...LOCAL_TTS_PACKAGE_IDS]);

/** Stable snapshot for useSyncExternalStore — identity changes only on write/event. */
let snapshot: LocalVoicePreferences = { ...DEFAULT_PREFS };
let snapshotStorage: Pick<Storage, "getItem"> | null | undefined = undefined;

function refreshSnapshot(
  storage: Pick<Storage, "getItem"> | null = typeof localStorage !== "undefined"
    ? localStorage
    : null,
): LocalVoicePreferences {
  snapshot = readLocalVoicePreferencesUncached(storage);
  snapshotStorage = storage;
  return snapshot;
}

function utf8Bytes(value: string): number {
  return typeof TextEncoder !== "undefined"
    ? new TextEncoder().encode(value).byteLength
    : value.length;
}

function looksSecret(value: string): boolean {
  return /sk-|api[_-]?key|bearer\s|token/i.test(value);
}

/** Strict parse: unknown shapes and stale package IDs become Browser defaults. */
export function parseLocalVoicePreferences(raw: unknown): LocalVoicePreferences {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PREFS };
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) return { ...DEFAULT_PREFS };

  const sttRaw = typeof record.stt === "string" ? record.stt.trim() : "";
  const ttsRaw = typeof record.tts === "string" ? record.tts.trim() : "";

  if (
    !sttRaw ||
    sttRaw.length > 64 ||
    looksSecret(sttRaw) ||
    !STT_SET.has(sttRaw) ||
    !ttsRaw ||
    ttsRaw.length > 64 ||
    looksSecret(ttsRaw) ||
    !TTS_SET.has(ttsRaw)
  ) {
    return { ...DEFAULT_PREFS };
  }

  return {
    version: 1,
    stt: sttRaw as LocalSttPreference,
    tts: ttsRaw as LocalTtsPreference,
  };
}

function readLocalVoicePreferencesUncached(
  storage: Pick<Storage, "getItem"> | null,
): LocalVoicePreferences {
  if (!storage) return { ...DEFAULT_PREFS };
  try {
    const raw = storage.getItem(LOCAL_VOICE_PREFERENCES_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    if (utf8Bytes(raw) > LOCAL_VOICE_PREFERENCES_MAX_BYTES) return { ...DEFAULT_PREFS };
    return parseLocalVoicePreferences(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function readLocalVoicePreferences(
  storage: Pick<Storage, "getItem"> | null = typeof localStorage !== "undefined"
    ? localStorage
    : null,
): LocalVoicePreferences {
  // When reading the live default storage, return the cached snapshot identity
  // so useSyncExternalStore does not loop on fresh object literals.
  if (
    storage === (typeof localStorage !== "undefined" ? localStorage : null) &&
    snapshotStorage === storage
  ) {
    return snapshot;
  }
  return readLocalVoicePreferencesUncached(storage);
}

/** Force-refresh the live snapshot (tests / explicit reload). */
export function resetLocalVoicePreferencesSnapshot(
  storage: Pick<Storage, "getItem"> | null = typeof localStorage !== "undefined"
    ? localStorage
    : null,
): LocalVoicePreferences {
  return refreshSnapshot(storage);
}

function emitPreferencesChanged(prefs: LocalVoicePreferences): void {
  snapshot = prefs;
  snapshotStorage = typeof localStorage !== "undefined" ? localStorage : null;
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent(LOCAL_VOICE_PREFERENCES_EVENT, {
        detail: prefs,
      }),
    );
  } catch {
    // ignore
  }
}

export function writeLocalVoicePreferences(
  prefs: LocalVoicePreferences,
  storage: Pick<Storage, "setItem" | "removeItem"> | null = typeof localStorage !== "undefined"
    ? localStorage
    : null,
): LocalVoicePreferences {
  const next = parseLocalVoicePreferences(prefs);
  if (!storage) {
    emitPreferencesChanged(next);
    return next;
  }

  // Default browser/browser clears the key entirely.
  if (next.stt === "browser" && next.tts === "browser") {
    try {
      storage.removeItem(LOCAL_VOICE_PREFERENCES_STORAGE_KEY);
    } catch {
      // ignore quota / private-mode failures
    }
    emitPreferencesChanged(next);
    return next;
  }

  const payload = JSON.stringify({
    version: 1 as const,
    stt: next.stt,
    tts: next.tts,
  });
  if (utf8Bytes(payload) > LOCAL_VOICE_PREFERENCES_MAX_BYTES) {
    return readLocalVoicePreferencesUncached(
      typeof localStorage !== "undefined" ? localStorage : null,
    );
  }

  try {
    storage.setItem(LOCAL_VOICE_PREFERENCES_STORAGE_KEY, payload);
  } catch {
    // ignore quota / private-mode failures
  }
  emitPreferencesChanged(next);
  return next;
}

export function isLocalSttPackageId(value: string): value is LocalSttPackageId {
  return (LOCAL_STT_PACKAGE_IDS as readonly string[]).includes(value);
}

export function isLocalTtsPackageId(value: string): value is LocalTtsPackageId {
  return (LOCAL_TTS_PACKAGE_IDS as readonly string[]).includes(value);
}

export function subscribeLocalVoicePreferences(onChange: () => void): () => void {
  // Ensure first subscriber sees current storage contents without changing
  // identity when values are unchanged.
  const previous = snapshot;
  const next = readLocalVoicePreferencesUncached(
    typeof localStorage !== "undefined" ? localStorage : null,
  );
  if (previous.stt !== next.stt || previous.tts !== next.tts || previous.version !== next.version) {
    snapshot = next;
    snapshotStorage = typeof localStorage !== "undefined" ? localStorage : null;
  } else if (snapshotStorage === undefined) {
    snapshotStorage = typeof localStorage !== "undefined" ? localStorage : null;
  }

  if (typeof window === "undefined") return () => {};

  // writeLocalVoicePreferences already updates the snapshot before emitting.
  const onCustom = () => onChange();
  const onStorage = (event: StorageEvent) => {
    if (event.key === LOCAL_VOICE_PREFERENCES_STORAGE_KEY || event.key === null) {
      refreshSnapshot();
      onChange();
    }
  };

  window.addEventListener(LOCAL_VOICE_PREFERENCES_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(LOCAL_VOICE_PREFERENCES_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

// Initialize live snapshot when localStorage exists (browser / jsdom).
if (typeof localStorage !== "undefined") {
  refreshSnapshot(localStorage);
}
