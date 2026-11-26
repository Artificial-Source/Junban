/**
 * Compile-time alignment against installed package types (not imported at runtime).
 * Checks the call shapes of Transformers.js, Kokoro, and Piper without
 * pulling the engines into ordinary chunks.
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
    onnxWasm: { mjs: string; wasm: string };
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
  wasmPaths: { onnxWasm: { mjs: "/", wasm: "/" }, piperData: "/", piperWasm: "/" },
};

void _whisperTask;
void _whisperOpts;
void _kokoroOpts;
void _kokoroVoice;
void _piperOpts;
