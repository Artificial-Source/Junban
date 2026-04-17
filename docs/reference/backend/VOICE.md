# Voice Subsystem — Internal Documentation

The voice subsystem (`src/ai/voice/`) implements Junban's speech-to-text (STT) and text-to-speech (TTS) capabilities. It follows the same provider-plugin pattern as the LLM subsystem: a registry holds provider plugins, each implementing a common interface. Providers range from free browser-native APIs to cloud services (Groq, Inworld AI) and fully local WASM-based models (Whisper, Kokoro, Piper).

Boundary note: this page is the voice-specific reference for `src/ai/voice/**`. Cross-cutting AI chat/pipeline/provider architecture is documented in [`AI.md`](AI.md).

---

## Architecture Overview

```
STT Flow (Speech to Text):
  Microphone Input
       |
       v
  Browser STT: Web Speech API (live recognition, no audio blob)
  -- OR --
  Push-to-Talk: MediaRecorder -> audio Blob
       |
       v
  STTProviderPlugin.transcribe(blob) or BrowserSTT.startLiveRecognition()
       |
       v
  Transcript string -> ChatSession.addUserMessage()

TTS Flow (Text to Speech):
  AI Response text
       |
       v
  TTSProviderPlugin.synthesize(text)
       |
       v
  ArrayBuffer (WAV/MP3)
       |
       v
  playAudioBuffer() -> Web Audio API -> Speaker

Local Model Flow (Whisper/Kokoro):
  First use: download model (~40-160MB) -> Cache Storage / OPFS
  Subsequent uses: load from cache -> WASM inference
  Kokoro runs in a dedicated Web Worker to prevent UI freezes
```

---

## Core

### `interface.ts`

**Path:** `src/ai/voice/interface.ts`
**Purpose:** Defines the STT and TTS provider plugin interfaces. Mirrors the `LLMProviderPlugin` pattern from the AI subsystem.
**Key Exports:**

- `STTOptions` — `{ language?, model? }`
- `TTSOptions` — `{ voice?, model?, speed?, responseFormat? }`
- `TTSModel` — `{ id, name }`
- `Voice` — `{ id, name }`
- `STTProviderPlugin` — interface:
  - `id`, `name`, `needsApiKey` (readonly)
  - `transcribe(audio: Blob, opts?)` — convert audio blob to text
  - `isAvailable()` — check environment support
  - `deleteModel?()` — delete cached model files
  - `getModelSize?()` — get cached model size in bytes
- `TTSProviderPlugin` — interface:
  - `id`, `name`, `needsApiKey` (readonly)
  - `synthesize(text, opts?)` — convert text to `ArrayBuffer`
  - `getVoices?()` — list available voices
  - `getModels?()` — list available models
  - `isAvailable()` — check environment support
  - `deleteModel?()` — delete cached model files
  - `getModelSize?()` — get cached model size in bytes
    **Key Dependencies:** None (pure interfaces)
    **Used By:** All voice adapters, `registry.ts`, `provider.ts`, UI voice components

---

### `registry.ts`

**Path:** `src/ai/voice/registry.ts`
**Purpose:** Registry for STT and TTS provider plugins. Same pattern as `LLMProviderRegistry`.
**Key Exports:**

- `VoiceProviderRegistry` — class:
  - `registerSTT(plugin)` / `registerTTS(plugin)` — register providers (throws on duplicate ID)
  - `unregisterSTT(id)` / `unregisterTTS(id)` — remove providers
  - `getSTT(id)` / `getTTS(id)` — get by ID
  - `listSTT()` / `listTTS()` — list all registered providers
    **Key Dependencies:** `STTProviderPlugin`, `TTSProviderPlugin`
    **Used By:** `provider.ts`, UI settings, voice call components

---

### `provider.ts`

**Path:** `src/ai/voice/provider.ts`
**Purpose:** Factory that creates a `VoiceProviderRegistry` with all default providers registered.
**Key Exports:**

- `VoiceProviderConfig` — `{ groqApiKey?, inworldApiKey? }`
- `createDefaultVoiceRegistry(config?)` — creates registry and registers:
  - **Always registered (no API key needed):**
    - `BrowserSTTProvider` (free fallback)
    - `BrowserTTSProvider` (free fallback)
    - `WhisperLocalSTTProvider` (local WASM)
    - `PiperLocalTTSProvider` (local WASM)
    - `KokoroLocalTTSProvider` (local WASM)
  - **Conditionally registered (require API key):**
    - `GroqSTTProvider` (when `groqApiKey` provided)
    - `GroqTTSProvider` (when `groqApiKey` provided)
  - **Conditionally registered (require API key):** - `InworldTTSProvider` (registered only when `inworldApiKey` is provided)
    **Key Dependencies:** All adapter classes
    **Used By:** App initialization, settings context

---

### `audio-utils.ts`

**Path:** `src/ai/voice/audio-utils.ts`
**Purpose:** Audio utility functions for voice integration: WAV conversion, recording, microphone management, and playback.
**Key Exports:**

- `float32ToWav(samples, sampleRate)` — converts Float32Array PCM samples to a WAV Blob. Writes RIFF/WAV header, converts float32 to int16.
- `createAudioRecorder(deviceId?)` — MediaRecorder wrapper for push-to-talk:
  - `start()` — requests microphone, starts recording as `audio/webm`
  - `stop()` — stops recording, releases mic, returns Blob
- `MicrophoneInfo` — `{ deviceId, label }`
- `enumerateMicrophones()` — lists audio input devices (does NOT request permission)
- `triggerMicPermissionPrompt(timeoutMs?)` — triggers the browser's mic permission dialog. Returns false on timeout (handles Linux/PipeWire hangs). Default timeout: 8 seconds.
- `AudioPlayback` — `{ promise, cancel }` — cancellable playback handle
- `playAudioBuffer(buffer)` — plays an ArrayBuffer through Web Audio API. Returns a cancellable handle. Uses `decodeAudioData` + `AudioBufferSourceNode`.
  **Key Dependencies:** Browser APIs (MediaRecorder, AudioContext, navigator.mediaDevices)
  **Used By:** Voice call components, `kokoro.worker.ts`, all TTS adapters (indirectly via playback)

---

## STT Adapters

### `browser-stt.ts`

**Path:** `src/ai/voice/adapters/browser-stt.ts`
**Purpose:** Browser-native STT adapter wrapping the Web Speech API. Free, no API key. Default/fallback STT provider.
**Key Exports:**

- `BrowserSTTProvider` — implements `STTProviderPlugin`:
  - `id`: `"browser-stt"`
  - `name`: `"Browser (Web Speech API)"`
  - `needsApiKey`: `false`
  - `transcribe()` — throws Error; Browser STT does not accept audio blobs
  - `startLiveRecognition(opts?)` — starts live microphone recognition via `SpeechRecognition` API. Returns a Promise resolving to the transcript string. Handles:
    - `onresult` — extracts transcript from first result
    - `onerror` — resolves empty for "no-speech"/"aborted", rejects for real errors
    - `onend` — resolves empty if no result
    - Configures `continuous: false`, `interimResults: false`, `lang` from opts
  - `isAvailable()` — checks for `SpeechRecognition` or `webkitSpeechRecognition` in window
    **Configuration:** Language via `opts.language` (default: `"en-US"`)
    **Key Dependencies:** Web Speech API (browser-native)
    **Used By:** `provider.ts`, voice call overlay

---

### `groq-stt.ts`

**Path:** `src/ai/voice/adapters/groq-stt.ts`
**Purpose:** Groq cloud STT adapter. Uses Whisper via OpenAI-compatible API, proxied through Vite middleware to avoid CORS.
**Key Exports:**

- `GroqSTTProvider` — implements `STTProviderPlugin`:
  - `id`: `"groq-stt"`
  - `name`: `"Groq (Whisper)"`
  - `needsApiKey`: `true`
  - `transcribe(audio, opts?)` — sends `FormData` with audio blob to `/api/voice/transcribe`. Uses model `whisper-large-v3-turbo` by default. Passes API key via `X-Api-Key` header.
  - `isAvailable()` — returns `true` if API key is set
    **Configuration:**
- `apiKey` — required, passed to constructor
- `baseUrl` — proxy endpoint (default: `/api/voice/transcribe`)
- `model` — via opts (default: `whisper-large-v3-turbo`)
- `language` — via opts
  **Key Dependencies:** Fetch API, Vite proxy middleware
  **Used By:** `provider.ts`

---

### `whisper-local-stt.ts`

**Path:** `src/ai/voice/adapters/whisper-local-stt.ts`
**Purpose:** Local Whisper STT using `@huggingface/transformers`. Runs Whisper ONNX models entirely in the browser via WASM. Model downloaded and cached on first use (~40MB for tiny.en quantized).
**Key Exports:**

- `ModelStatus` — `"idle" | "loading" | "ready" | "error"`
- `WhisperLocalSTTProvider` — implements `STTProviderPlugin`:
  - `id`: `"whisper-local"`
  - `name`: `"Whisper (Local)"`
  - `needsApiKey`: `false`
  - `modelId`: HuggingFace model ID (default: `"onnx-community/whisper-tiny.en"`)
  - `status` / `progress` — observable loading state
  - `onStatusChange?` — callback for status/progress updates
  - `preload()` — pre-downloads the model
  - `transcribe(audio)` — decodes audio blob to 16kHz Float32Array, runs through Whisper pipeline
  - `isAvailable()` — checks for WebAssembly support
  - `checkCached()` — checks if model files exist in Cache Storage
  - `deleteModel()` — removes cached model files, resets state
  - `getModelSize()` — returns total cached file size in bytes
    **Key internals:**
- `ensureModel()` / `loadModel()` — lazy model loading with progress callbacks
- `decodeAudioBlob()` — converts any audio format to mono Float32Array at target sample rate using OfflineAudioContext
- Model loading: uses `@huggingface/transformers` `pipeline("automatic-speech-recognition", ...)` with `dtype: "q4"`, `device: "wasm"`
  **Configuration:**
- `modelId` — HuggingFace model identifier (default: `onnx-community/whisper-tiny.en`)
  **Key Dependencies:** `@huggingface/transformers` (dynamic import), Web Audio API, Cache Storage API
  **Used By:** `provider.ts`, voice settings UI

---

## TTS Adapters

### `browser-tts.ts`

**Path:** `src/ai/voice/adapters/browser-tts.ts`
**Purpose:** Browser-native TTS adapter wrapping the Web Speech Synthesis API. Free, no API key. Default/fallback TTS provider.
**Key Exports:**

- `BrowserTTSProvider` — implements `TTSProviderPlugin`:
  - `id`: `"browser-tts"`
  - `name`: `"Browser (Speech Synthesis)"`
  - `needsApiKey`: `false`
  - `synthesize(text, opts?)` — plays audio directly via `speakDirect()`, returns empty ArrayBuffer (browser TTS does not produce audio buffers)
  - `speakDirect(text, opts?)` — creates a `SpeechSynthesisUtterance`, sets voice and speed, plays through `window.speechSynthesis.speak()`
  - `getVoices()` — lists browser voices with async loading fallback (some browsers load voices asynchronously)
  - `isAvailable()` — checks for `speechSynthesis` in window
    **Configuration:**
- `voice` — matched by `voiceURI` or `name`
- `speed` — maps to `utterance.rate`
  **Key Dependencies:** Web Speech Synthesis API (browser-native)
  **Used By:** `provider.ts`

---

### `groq-tts.ts`

**Path:** `src/ai/voice/adapters/groq-tts.ts`
**Purpose:** Groq cloud TTS adapter using PlayAI TTS. Proxied through Vite middleware to avoid CORS.
**Key Exports:**

- `GroqTTSProvider` — implements `TTSProviderPlugin`:
  - `id`: `"groq-tts"`
  - `name`: `"Groq (PlayAI)"`
  - `needsApiKey`: `true`
  - `synthesize(text, opts?)` — POSTs JSON to `/api/voice/synthesize`. Default voice: `"Fritz-PlayAI"`, format: `"wav"`.
  - `getVoices()` — returns 20 hardcoded PlayAI voices
  - `isAvailable()` — returns true if API key is set
    **Available voices (20):** Arista, Atlas, Basil, Briggs, Calista, Celeste, Cheyenne, Chip, Cillian, Deedee, Fritz, Gail, Indigo, Mamaw, Mason, Mikail, Mitch, Nia, Quinn, Thunder
    **Configuration:**
- `apiKey` — required
- `baseUrl` — proxy endpoint (default: `/api/voice/synthesize`)
- `voice` — via opts
- `speed` — via opts
  **Key Dependencies:** Fetch API, Vite proxy middleware
  **Used By:** `provider.ts`

---

### `inworld-tts.ts`

**Path:** `src/ai/voice/adapters/inworld-tts.ts`
**Purpose:** Inworld AI TTS adapter. High-quality, low-latency TTS with 15-language support. Proxied through Vite middleware.
**Key Exports:**

- `InworldTTSProvider` — implements `TTSProviderPlugin`:
  - `id`: `"inworld-tts"`
  - `name`: `"Inworld AI"`
  - `needsApiKey`: `true`
  - `synthesize(text, opts?)` — POSTs to `/api/voice/inworld-synthesize`. Default voice: `"Ashley"`, default model: `"inworld-tts-1.5-max"`, audio format: MP3.
  - `getVoices()` — fetches voice list from `/api/voice/inworld-voices` endpoint
  - `getModels()` — returns 4 hardcoded models
  - `isAvailable()` — returns true if API key is set
    **Available models:**
- `inworld-tts-1.5-max` — TTS 1.5 Max (best quality, ~200ms latency)
- `inworld-tts-1.5-mini` — TTS 1.5 Mini (fastest, ~100ms latency)
- `inworld-tts-1-max` — TTS 1.0 Max
- `inworld-tts-1` — TTS 1.0
  **Configuration:**
- `apiKey` — required
- `baseUrl` — proxy endpoint (default: `/api/voice/inworld-synthesize`)
- `voice` — voice ID string
- `model` — model ID string
  **Key Dependencies:** Fetch API, Vite proxy middleware
  **Used By:** `provider.ts`

---

### `kokoro-local-tts.ts`

**Path:** `src/ai/voice/adapters/kokoro-local-tts.ts`
**Purpose:** Local Kokoro TTS using `kokoro-js` via a dedicated Web Worker. Runs ONNX inference entirely in the browser. Model downloaded and cached on first use (~160MB).
**Key Exports:**

- `ModelStatus` — `"idle" | "loading" | "ready" | "error"`
- `KokoroLocalTTSProvider` — implements `TTSProviderPlugin`:
  - `id`: `"kokoro-local"`
  - `name`: `"Kokoro (Local)"`
  - `needsApiKey`: `false`
  - `modelId`: ONNX model (default: `"onnx-community/Kokoro-82M-v1.0-ONNX"`)
  - `status` / `progress` — observable loading state
  - `onStatusChange?` — callback
  - `preload()` — pre-downloads model in worker
  - `synthesize(text, opts?)` — sends synthesize request to worker, returns WAV ArrayBuffer. Default voice: `"af_heart"`.
  - `getVoices()` — returns 21 hardcoded voices
  - `isAvailable()` — checks for WebAssembly support
  - `checkCached()` / `deleteModel()` / `getModelSize()` — Cache Storage management
    **Available voices (21):** Heart, Alloy, Aoede, Bella, Jessica, Kore, Nicole, Nova, River, Sarah, Sky (female); Adam, Echo, Eric, Liam, Michael, Onyx, Puck, Santa (male); Emma (British female); George (British male)
    **Key internals:**
- `createWorker()` — spawns `kokoro.worker.ts` as a module Worker
- `handleWorkerMessage()` — processes load-progress, load-complete, load-error, synthesize-complete, synthesize-error
- `handleWorkerCrash()` — rejects all pending syntheses, terminates worker
- `pendingSyntheses` — Map tracking in-flight synthesis requests by ID
- Communication with worker via `KokoroWorkerRequest`/`KokoroWorkerResponse` typed messages
  **Key Dependencies:** Web Workers, Cache Storage API, `kokoro-worker-types.ts`
  **Used By:** `provider.ts`, voice settings UI

---

### `piper-local-tts.ts`

**Path:** `src/ai/voice/adapters/piper-local-tts.ts`
**Purpose:** Local Piper TTS using `@mintplex-labs/piper-tts-web`. Runs Piper models via WASM with OPFS (Origin Private File System) caching. Per-voice models are ~60-75MB each.
**Key Exports:**

- `ModelStatus` — `"idle" | "loading" | "ready" | "error"`
- `PiperLocalTTSProvider` — implements `TTSProviderPlugin`:
  - `id`: `"piper-local"`
  - `name`: `"Piper (Local)"`
  - `needsApiKey`: `false`
  - `status` / `progress` — observable loading state
  - `onStatusChange?` — callback
  - `preload()` — pre-downloads the default voice model
  - `synthesize(text, opts?)` — generates speech as a Blob, converts to ArrayBuffer. Default voice: `"en_US-hfc_female-medium"`. Downloads model on first use with progress callbacks.
  - `getVoices()` — returns 10 hardcoded voices
  - `isAvailable()` — checks for WebAssembly support
  - `checkCached()` — checks OPFS `piper/` directory for `.onnx` files
  - `deleteModel()` — removes OPFS `piper/` directory
  - `getModelSize()` — sums file sizes in OPFS `piper/` directory
    **Available voices (10):** HFC Female (US), HFC Male (US), Amy (US), Danny (US), Joe (US), Kristin (US), Lessac (US), Ryan (US), Alba (UK), Cori (UK)
    **Configuration:**
- `defaultVoice` — voice ID (default: `"en_US-hfc_female-medium"`)
  **Key Dependencies:** `@mintplex-labs/piper-tts-web` (dynamic import), OPFS API
  **Used By:** `provider.ts`, voice settings UI

---

## Workers

### `kokoro.worker.ts`

**Path:** `src/ai/voice/workers/kokoro.worker.ts`
**Purpose:** Dedicated Web Worker for Kokoro TTS ONNX WASM inference. Runs off the main thread to prevent UI freezes.
**Key behavior:**

- Listens for `"load"` message:
  - Dynamically imports `kokoro-js`
  - Calls `KokoroTTS.from_pretrained(modelId)` with WASM device
  - Reports progress via `"load-progress"` messages
  - Signals completion via `"load-complete"` or failure via `"load-error"`
- Listens for `"synthesize"` message:
  - Calls `ttsInstance.generate(text, { voice })`
  - Converts Float32Array output to WAV using `float32ToWav()`
  - Transfers the ArrayBuffer back via `"synthesize-complete"` (using Transferable for zero-copy)
  - Reports errors via `"synthesize-error"`
    **Key Dependencies:** `kokoro-js` (dynamic import), `float32ToWav` from `audio-utils.ts`
    **Used By:** `kokoro-local-tts.ts` (spawns this as a Worker)

---

### `kokoro-worker-types.ts`

**Path:** `src/ai/voice/workers/kokoro-worker-types.ts`
**Purpose:** Shared message protocol types for the Kokoro Web Worker.
**Key Exports:**

- `KokoroWorkerRequest` — discriminated union:
  - `{ type: "load", modelId: string }`
  - `{ type: "synthesize", id: string, text: string, voice: string }`
- `KokoroWorkerResponse` — discriminated union:
  - `{ type: "load-progress", progress: number }`
  - `{ type: "load-complete" }`
  - `{ type: "load-error", error: string }`
  - `{ type: "synthesize-complete", id: string, buffer: ArrayBuffer }`
  - `{ type: "synthesize-error", id: string, error: string }`
    **Key Dependencies:** None (pure types)
    **Used By:** `kokoro.worker.ts`, `kokoro-local-tts.ts`

---

## Provider Summary

### STT Providers

| Provider                 | ID              | API Key | Runs Locally  | Model                   | Accepts Audio Blob |
| ------------------------ | --------------- | ------- | ------------- | ----------------------- | ------------------ |
| Browser (Web Speech API) | `browser-stt`   | No      | Yes (browser) | N/A                     | No (live mic only) |
| Groq (Whisper)           | `groq-stt`      | Yes     | No (cloud)    | whisper-large-v3-turbo  | Yes                |
| Whisper (Local)          | `whisper-local` | No      | Yes (WASM)    | whisper-tiny.en (~40MB) | Yes                |

### TTS Providers

| Provider                   | ID             | API Key | Runs Locally      | Output Format   | Voices        |
| -------------------------- | -------------- | ------- | ----------------- | --------------- | ------------- |
| Browser (Speech Synthesis) | `browser-tts`  | No      | Yes (browser)     | Direct playback | System voices |
| Groq (PlayAI)              | `groq-tts`     | Yes     | No (cloud)        | WAV             | 20 voices     |
| Inworld AI                 | `inworld-tts`  | Yes     | No (cloud)        | MP3             | Dynamic (API) |
| Kokoro (Local)             | `kokoro-local` | No      | Yes (WASM Worker) | WAV             | 21 voices     |
| Piper (Local)              | `piper-local`  | No      | Yes (WASM)        | WAV             | 10 voices     |

### Local Model Cache Sizes

| Model                | Approximate Size | Cache Location |
| -------------------- | ---------------- | -------------- |
| Whisper tiny.en (q4) | ~40 MB           | Cache Storage  |
| Kokoro 82M ONNX      | ~160 MB          | Cache Storage  |
| Piper (per voice)    | ~60-75 MB        | OPFS           |
