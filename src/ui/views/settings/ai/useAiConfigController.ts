/**
 * Settings-local confirmed AI/Voice config controller.
 *
 * Fetches only while mounted (AI/Voice tabs). Draft edits never apply to app
 * runtime — only server-confirmed snapshots drive “configured” display after
 * successful save/refetch. One operation UUID per logical write; no automatic
 * retry of ambiguous mutations.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../../api/client";
import { createAiOperationId } from "../../../ai/operation-id";
import {
  deleteAiCredential,
  discoverAiProviderModels,
  getAiConfig,
  listAiProviders,
  putAiConfig,
  putAiCredential,
  sanitizeTransportError,
} from "../../../ai/transport";
import type {
  AiConfigInput,
  AiConfigPutRequest,
  AiConfigResponse,
  AiCredentialTargetDto,
  AiProviderPresetDto,
  AiProviderRegistryEntry,
  AiSecretKindDto,
  DiscoveredModelDto,
  PutAiCredentialRequest,
  VoiceConfigInput,
} from "../../../ai/types";
import { fixtureAiConfig, fixtureAiProviders, readAiSettingsVisualState } from "./aiFixture";
import { fixtureVoiceConfig, readVoiceSettingsVisualState } from "../voice/voiceFixture";

export type AiDraft = AiConfigInput;
export type VoiceDraft = VoiceConfigInput;

function aiToDraft(ai: AiConfigResponse["ai"]): AiDraft {
  return {
    enabled: ai.enabled,
    provider: ai.provider ?? null,
    model: ai.model ?? null,
    base_url: ai.base_url ?? null,
    custom_instructions: ai.custom_instructions,
    daily_briefing_enabled: ai.daily_briefing_enabled,
    default_energy: ai.default_energy ?? null,
    auto_send: ai.auto_send,
    smart_endpoint: ai.smart_endpoint,
  };
}

function voiceToDraft(voice: AiConfigResponse["voice"]): VoiceDraft {
  return {
    cloud_speech_enabled: voice.cloud_speech_enabled,
    grace_period_ms: voice.grace_period_ms,
    stt_provider: voice.stt_provider,
    stt_model: voice.stt_model ?? null,
    tts_enabled: voice.tts_enabled,
    tts_provider: voice.tts_provider,
    tts_model: voice.tts_model ?? null,
    tts_voice: voice.tts_voice ?? null,
    voice_mode: voice.voice_mode,
  };
}

function draftsEqual(a: AiDraft, b: AiDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function voiceDraftsEqual(a: VoiceDraft, b: VoiceDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function errorMessage(error: unknown): string {
  const safe = sanitizeTransportError(error);
  if (safe instanceof ApiError) return safe.message;
  return safe.message || "Request failed";
}

function resolveFixtureConfig(): AiConfigResponse | null {
  const aiState = readAiSettingsVisualState();
  if (aiState) return fixtureAiConfig(aiState);
  const voiceState = readVoiceSettingsVisualState();
  if (voiceState) return fixtureVoiceConfig(voiceState);
  return null;
}

export type UseAiConfigControllerResult = {
  loading: boolean;
  saving: boolean;
  error: string | null;
  statusMessage: string | null;
  confirmed: AiConfigResponse | null;
  providers: AiProviderRegistryEntry[];
  aiDraft: AiDraft | null;
  voiceDraft: VoiceDraft | null;
  aiDirty: boolean;
  voiceDirty: boolean;
  dirty: boolean;
  isConfigured: boolean;
  selectedProvider: AiProviderRegistryEntry | null;
  discoveredModels: DiscoveredModelDto[];
  modelsLoading: boolean;
  modelsError: string | null;
  setAiDraft: (patch: Partial<AiDraft>) => void;
  setVoiceDraft: (patch: Partial<VoiceDraft>) => void;
  replaceAiDraft: (draft: AiDraft) => void;
  replaceVoiceDraft: (draft: VoiceDraft) => void;
  clearError: () => void;
  refresh: () => Promise<void>;
  save: () => Promise<boolean>;
  discoverModels: () => Promise<void>;
  clearDiscoveredModels: () => void;
  /**
   * When the draft provider differs from a confirmed provider that still has a
   * bound credential, callers must confirm before save — this flag surfaces it.
   */
  providerCredentialSwitchRequired: boolean;
  deleteCredentialThenSave: (target?: AiCredentialTargetDto) => Promise<boolean>;
  submitCredential: (
    target: AiCredentialTargetDto,
    body: PutAiCredentialRequest,
  ) => Promise<boolean>;
  removeCredential: (target: AiCredentialTargetDto) => Promise<boolean>;
  credentialBusy: AiCredentialTargetDto | null;
};

export function useAiConfigController(): UseAiConfigControllerResult {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [credentialBusy, setCredentialBusy] = useState<AiCredentialTargetDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<AiConfigResponse | null>(null);
  const [providers, setProviders] = useState<AiProviderRegistryEntry[]>([]);
  const [aiDraft, setAiDraftState] = useState<AiDraft | null>(null);
  const [voiceDraft, setVoiceDraftState] = useState<VoiceDraft | null>(null);
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModelDto[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const fixtureMode = useRef(resolveFixtureConfig() !== null).current;

  const applyConfirmed = useCallback((response: AiConfigResponse) => {
    setConfirmed(response);
    setAiDraftState(aiToDraft(response.ai));
    setVoiceDraftState(voiceToDraft(response.voice));
  }, []);

  const refresh = useCallback(async () => {
    const fixture = resolveFixtureConfig();
    if (fixture) {
      applyConfirmed(fixture);
      setProviders(fixtureAiProviders());
      setLoading(false);
      setError(null);
      return;
    }

    const generation = ++generationRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const [config, registry] = await Promise.all([
        getAiConfig({ signal: controller.signal }),
        listAiProviders({ signal: controller.signal }),
      ]);
      if (generation !== generationRef.current) return;
      applyConfirmed(config);
      setProviders(registry.providers);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (generation !== generationRef.current) return;
      setError(errorMessage(err));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [applyConfirmed]);

  useEffect(() => {
    void refresh();
    return () => {
      generationRef.current += 1;
      abortRef.current?.abort();
    };
  }, [refresh]);

  const setAiDraft = useCallback((patch: Partial<AiDraft>) => {
    setStatusMessage(null);
    setAiDraftState((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const setVoiceDraft = useCallback((patch: Partial<VoiceDraft>) => {
    setStatusMessage(null);
    setVoiceDraftState((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const replaceAiDraft = useCallback((draft: AiDraft) => {
    setStatusMessage(null);
    setAiDraftState(draft);
  }, []);

  const replaceVoiceDraft = useCallback((draft: VoiceDraft) => {
    setStatusMessage(null);
    setVoiceDraftState(draft);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const confirmedAiDraft = useMemo(() => (confirmed ? aiToDraft(confirmed.ai) : null), [confirmed]);
  const confirmedVoiceDraft = useMemo(
    () => (confirmed ? voiceToDraft(confirmed.voice) : null),
    [confirmed],
  );

  const aiDirty = Boolean(aiDraft && confirmedAiDraft && !draftsEqual(aiDraft, confirmedAiDraft));
  const voiceDirty = Boolean(
    voiceDraft && confirmedVoiceDraft && !voiceDraftsEqual(voiceDraft, confirmedVoiceDraft),
  );
  const dirty = aiDirty || voiceDirty;

  const selectedProvider = useMemo(() => {
    if (!aiDraft?.provider) return null;
    return providers.find((entry) => entry.id === aiDraft.provider) ?? null;
  }, [aiDraft?.provider, providers]);

  const isConfigured = useMemo(() => {
    if (!confirmed) return false;
    const { ai, credentials } = confirmed;
    if (!ai.enabled || !ai.provider || !ai.model) return false;
    const entry = providers.find((p) => p.id === ai.provider);
    if (entry?.credential_required && !credentials.ai_provider?.present) return false;
    return true;
  }, [confirmed, providers]);

  const providerCredentialSwitchRequired = useMemo(() => {
    if (!confirmed || !aiDraft) return false;
    const prev = confirmed.ai.provider ?? null;
    const next = aiDraft.provider ?? null;
    if (prev === next) return false;
    return Boolean(prev && confirmed.credentials.ai_provider?.present);
  }, [aiDraft, confirmed]);

  const buildPutBody = useCallback((): AiConfigPutRequest | null => {
    if (!aiDraft || !voiceDraft) return null;
    return { ai: aiDraft, voice: voiceDraft };
  }, [aiDraft, voiceDraft]);

  const save = useCallback(async (): Promise<boolean> => {
    if (fixtureMode) {
      setStatusMessage("Fixture mode — changes are not saved.");
      return false;
    }
    if (providerCredentialSwitchRequired) {
      setError("Confirm removing the previous provider credential before saving.");
      return false;
    }
    const body = buildPutBody();
    if (!body || saving) return false;
    setSaving(true);
    setError(null);
    setStatusMessage(null);
    const operationId = createAiOperationId();
    try {
      const response = await putAiConfig(body, { operationId });
      applyConfirmed(response);
      // Refetch authoritative credential presence after config commit.
      const fresh = await getAiConfig();
      applyConfirmed(fresh);
      setStatusMessage("Saved");
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setSaving(false);
    }
  }, [applyConfirmed, buildPutBody, fixtureMode, providerCredentialSwitchRequired, saving]);

  const deleteCredentialThenSave = useCallback(
    async (target: AiCredentialTargetDto = "ai_provider"): Promise<boolean> => {
      if (fixtureMode) {
        setStatusMessage("Fixture mode — changes are not saved.");
        return false;
      }
      if (saving || credentialBusy) return false;
      setCredentialBusy(target);
      setSaving(true);
      setError(null);
      setStatusMessage(null);
      const deleteOp = createAiOperationId();
      try {
        await deleteAiCredential(target, { operationId: deleteOp });
        const body = buildPutBody();
        if (!body) return false;
        const saveOp = createAiOperationId();
        const response = await putAiConfig(body, { operationId: saveOp });
        applyConfirmed(response);
        const fresh = await getAiConfig();
        applyConfirmed(fresh);
        setStatusMessage("Saved");
        return true;
      } catch (err) {
        setError(errorMessage(err));
        // Retain draft; attempt to refresh confirmed presence only.
        try {
          const fresh = await getAiConfig();
          setConfirmed(fresh);
        } catch {
          // keep prior confirmed
        }
        return false;
      } finally {
        setCredentialBusy(null);
        setSaving(false);
      }
    },
    [applyConfirmed, buildPutBody, credentialBusy, fixtureMode, saving],
  );

  const submitCredential = useCallback(
    async (target: AiCredentialTargetDto, body: PutAiCredentialRequest): Promise<boolean> => {
      if (fixtureMode) {
        setStatusMessage("Fixture mode — credentials are not stored.");
        return false;
      }
      if (credentialBusy) return false;
      setCredentialBusy(target);
      setError(null);
      setStatusMessage(null);
      const operationId = createAiOperationId();
      const request: PutAiCredentialRequest = {
        kind: body.kind,
        secret: body.secret,
      };
      try {
        await putAiCredential(target, request, { operationId });
        const fresh = await getAiConfig();
        applyConfirmed(fresh);
        setStatusMessage("Credential saved");
        return true;
      } catch (err) {
        setError(errorMessage(err));
        return false;
      } finally {
        (request as { secret?: string }).secret = undefined;
        setCredentialBusy(null);
      }
    },
    [applyConfirmed, credentialBusy, fixtureMode],
  );

  const removeCredential = useCallback(
    async (target: AiCredentialTargetDto): Promise<boolean> => {
      if (fixtureMode) {
        setStatusMessage("Fixture mode — credentials are not modified.");
        return false;
      }
      if (credentialBusy) return false;
      setCredentialBusy(target);
      setError(null);
      setStatusMessage(null);
      const operationId = createAiOperationId();
      try {
        await deleteAiCredential(target, { operationId });
        const fresh = await getAiConfig();
        applyConfirmed(fresh);
        setStatusMessage("Credential removed");
        return true;
      } catch (err) {
        setError(errorMessage(err));
        return false;
      } finally {
        setCredentialBusy(null);
      }
    },
    [applyConfirmed, credentialBusy, fixtureMode],
  );

  const discoverModels = useCallback(async () => {
    if (fixtureMode) {
      setDiscoveredModels([
        {
          id: "gpt-4.1",
          display_name: "GPT-4.1",
          capabilities: ["chat_streaming", "chat_completion"],
        },
      ]);
      setModelsError(null);
      return;
    }
    const provider = aiDraft?.provider as AiProviderPresetDto | null | undefined;
    if (!provider) {
      setModelsError("Select a provider before discovering models.");
      return;
    }
    setModelsLoading(true);
    setModelsError(null);
    try {
      const response = await discoverAiProviderModels(provider);
      setDiscoveredModels(response.models);
      if (response.models.length === 0) {
        setModelsError("No models returned. Enter a model name manually.");
      }
    } catch (err) {
      setDiscoveredModels([]);
      setModelsError(errorMessage(err));
    } finally {
      setModelsLoading(false);
    }
  }, [aiDraft?.provider, fixtureMode]);

  const clearDiscoveredModels = useCallback(() => {
    setDiscoveredModels([]);
    setModelsError(null);
  }, []);

  return {
    loading,
    saving,
    error,
    statusMessage,
    confirmed,
    providers,
    aiDraft,
    voiceDraft,
    aiDirty,
    voiceDirty,
    dirty,
    isConfigured,
    selectedProvider,
    discoveredModels,
    modelsLoading,
    modelsError,
    setAiDraft,
    setVoiceDraft,
    replaceAiDraft,
    replaceVoiceDraft,
    clearError,
    refresh,
    save,
    discoverModels,
    clearDiscoveredModels,
    providerCredentialSwitchRequired,
    deleteCredentialThenSave,
    submitCredential,
    removeCredential,
    credentialBusy,
  };
}

export type { AiSecretKindDto };
