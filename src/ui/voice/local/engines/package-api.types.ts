/**
 * Compile-time alignment against installed package types (not imported at runtime).
 * Ensures Wave 4g call shapes match Transformers.js 3.8.1, kokoro-js 1.2.1, and
 * @mintplex-labs/piper-tts-web 1.0.4 without pulling engines into ordinary chunks.
 */

import type { pipeline as TransformersPipeline, RawAudio } from "@huggingface/transformers";
import type { KokoroTTS } from "kokoro-js";
import type { TtsSession } from "@mintplex-labs/piper-tts-web";

/** Whisper: pipeline("automatic-speech-recognition", repo, {dtype:"q4",revision,device:"wasm"}). */
export type WhisperPipelineFactory = typeof TransformersPipeline;
export type WhisperPipelineOptions = {
  dtype: "q4";
  revision: string;
  device: "wasm";
};
export type WhisperTask = "automatic-speech-recognition";

/** Kokoro: KokoroTTS.from_pretrained(repo, {dtype:"q8", device:"wasm"}) + generate(..., {voice:"af_heart"}). */
export type KokoroFromPretrained = typeof KokoroTTS.from_pretrained;
export type KokoroGenerateOptions = { voice: "af_heart" };
export type KokoroRawAudio = RawAudio;
export type KokoroLoadOptionsAlign = {
  dtype: "q8";
  device: "wasm";
};

/** Piper: TtsSession.create({voiceId:"en_US-ljspeech-medium", wasmPaths}) + predict. */
export type PiperSessionCreate = typeof TtsSession.create;
export type PiperCreateOptions = {
  voiceId: "en_US-ljspeech-medium";
  wasmPaths: {
    onnxWasm: string;
    piperData: string;
    piperWasm: string;
  };
};

// Call-shape assignability against installed package option parameters.
type KokoroOptionsArg = NonNullable<Parameters<KokoroFromPretrained>[1]>;
type PiperOptionsArg = Parameters<PiperSessionCreate>[0];

const _whisperTask: WhisperTask = "automatic-speech-recognition";
const _whisperOpts: WhisperPipelineOptions = {
  dtype: "q4",
  revision: "rev",
  device: "wasm",
};
const _kokoroOpts: KokoroLoadOptionsAlign & KokoroOptionsArg = {
  dtype: "q8",
  device: "wasm",
};
const _kokoroVoice: KokoroGenerateOptions = { voice: "af_heart" };
const _piperOpts: PiperCreateOptions & PiperOptionsArg = {
  voiceId: "en_US-ljspeech-medium",
  wasmPaths: { onnxWasm: "/", piperData: "/", piperWasm: "/" },
};

void _whisperTask;
void _whisperOpts;
void _kokoroOpts;
void _kokoroVoice;
void _piperOpts;
