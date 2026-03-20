/**
 * Browser STT adapter wrapping the Web Speech API.
 * Free, no API key required. Default/fallback STT provider.
 */

import type { STTProviderPlugin, STTOptions } from "../interface.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("voice");

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
      const SpeechRecognitionCtor =
        window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognitionCtor) {
        reject(new Error("SpeechRecognition not supported in this browser"));
        return;
      }

      const recognition = new SpeechRecognitionCtor();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = opts?.language ?? "en-US";
      // Increase max silence before the API auto-stops (Chrome default is very short)
      // Not all browsers support this but it doesn't hurt to set it
      recognition.maxAlternatives = 1;

      let resolved = false;

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        if (resolved) return;
        resolved = true;
        const transcript = event.results[0]?.[0]?.transcript ?? "";
        log.debug("BrowserSTT onresult", { transcript });
        recognition.stop();
        resolve(transcript);
      };

      recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        if (resolved) return;
        const errorType = event.error;
        log.debug("BrowserSTT onerror", { errorType });
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
        log.debug("BrowserSTT onend (no result)");
        resolved = true;
        resolve("");
      };

      log.debug("BrowserSTT recognition.start()");
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
