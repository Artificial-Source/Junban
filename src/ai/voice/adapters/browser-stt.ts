/**
 * Browser STT adapter wrapping the Web Speech API.
 * Free, no API key required. Default/fallback STT provider.
 */

import type { STTProviderPlugin, STTOptions } from "../interface.js";

export class BrowserSTTProvider implements STTProviderPlugin {
  readonly id = "browser-stt";
  readonly name = "Browser (Web Speech API)";
  readonly needsApiKey = false;

  async transcribe(audio: Blob, opts?: STTOptions): Promise<string> {
    // Web Speech API doesn't accept audio blobs — it records from the microphone directly.
    // This method is only called by the push-to-talk / VAD path which records audio.
    // For Browser STT, we use the live recognition approach instead.
    // This path is a no-op; the live recognition is handled by startLiveRecognition().
    void audio;
    void opts;
    throw new Error(
      "Browser STT does not support transcribing audio blobs. Use startLiveRecognition() instead.",
    );
  }

  /** Start live recognition from the microphone. Returns a promise with the transcript. */
  startLiveRecognition(opts?: STTOptions): Promise<string> {
    return new Promise((resolve, reject) => {
      const SpeechRecognition =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SpeechRecognition) {
        reject(new Error("SpeechRecognition not supported in this browser"));
        return;
      }

      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = opts?.language ?? "en-US";
      // Increase max silence before the API auto-stops (Chrome default is very short)
      // Not all browsers support this but it doesn't hurt to set it
      try {
        (recognition as any).maxAlternatives = 1;
      } catch {
        /* ignore */
      }

      let resolved = false;

      recognition.onresult = (event: any) => {
        if (resolved) return;
        resolved = true;
        const transcript = event.results[0]?.[0]?.transcript ?? "";
        console.log("[BrowserSTT] onresult:", JSON.stringify(transcript));
        recognition.stop();
        resolve(transcript);
      };

      recognition.onerror = (event: any) => {
        if (resolved) return;
        const errorType = event.error;
        console.log("[BrowserSTT] onerror:", errorType);
        // "no-speech" is normal — user just hasn't spoken yet
        if (errorType === "no-speech" || errorType === "aborted") {
          resolved = true;
          resolve("");
          return;
        }
        resolved = true;
        reject(new Error(`Speech recognition error: ${errorType}`));
      };

      recognition.onend = () => {
        if (resolved) return;
        console.log("[BrowserSTT] onend (no result)");
        resolved = true;
        resolve("");
      };

      console.log("[BrowserSTT] recognition.start()");
      recognition.start();
    });
  }

  async isAvailable(): Promise<boolean> {
    return (
      typeof window !== "undefined" &&
      ("SpeechRecognition" in window || "webkitSpeechRecognition" in window)
    );
  }
}
