/**
 * STT (Speech-to-Text) and TTS (Text-to-Speech) provider interfaces.
 * Mirrors the LLMProviderPlugin pattern from src/ai/provider/interface.ts.
 */

export interface STTOptions {
  language?: string;
  model?: string;
}

export interface TTSOptions {
  voice?: string;
  model?: string;
  speed?: number;
  responseFormat?: string;
}

export interface TTSModel {
  id: string;
  name: string;
}

export interface Voice {
  id: string;
  name: string;
}

/** Speech-to-Text provider plugin. */
export interface STTProviderPlugin {
  readonly id: string;
  readonly name: string;
  readonly needsApiKey: boolean;

  /** Transcribe audio to text. */
  transcribe(audio: Blob, opts?: STTOptions): Promise<string>;

  /** Check if this provider is available in the current environment. */
  isAvailable(): Promise<boolean>;

  /** Delete cached model files. */
  deleteModel?(): Promise<void>;

  /** Get the size of cached model files in bytes. */
  getModelSize?(): Promise<number>;
}

/** Text-to-Speech provider plugin. */
export interface TTSProviderPlugin {
  readonly id: string;
  readonly name: string;
  readonly needsApiKey: boolean;

  /** Synthesize text to audio. */
  synthesize(text: string, opts?: TTSOptions): Promise<ArrayBuffer>;

  /** List available voices. */
  getVoices?(): Promise<Voice[]>;

  /** List available models. */
  getModels?(): Promise<TTSModel[]>;

  /** Check if this provider is available in the current environment. */
  isAvailable(): Promise<boolean>;

  /** Delete cached model files. */
  deleteModel?(): Promise<void>;

  /** Get the size of cached model files in bytes. */
  getModelSize?(): Promise<number>;
}
