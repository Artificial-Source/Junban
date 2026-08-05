/**
 * Lazy import boundary: opening ordinary settings modules must not pull AI/Voice
 * tab modules or local voice engine packages.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import settingsDialogSource from "../SettingsDialog.tsx?raw";
import essentialsSource from "../EssentialsTab.tsx?raw";
import appearanceSource from "../AppearanceTab.tsx?raw";
import featuresSource from "../FeaturesTab.tsx?raw";
import keyboardSource from "../KeyboardTab.tsx?raw";
import templatesSource from "../TemplatesTab.tsx?raw";
import dataSource from "../DataTab.tsx?raw";
import hostedSource from "../HostedTab.tsx?raw";
import diagnosticsSource from "../DiagnosticsTab.tsx?raw";
import useSettingsSaveSource from "../useSettingsSave.ts?raw";
import localModelCardSource from "../voice/LocalModelCard.tsx?raw";

describe("settings AI/Voice lazy boundary", () => {
  it("SettingsDialog only dynamic-imports AI and Voice tabs", () => {
    expect(settingsDialogSource).toMatch(/lazy\(\(\)\s*=>\s*import\("\.\/ai\/AiTab"\)/);
    expect(settingsDialogSource).toMatch(/lazy\(\(\)\s*=>\s*import\("\.\/voice\/VoiceTab"\)/);
    expect(settingsDialogSource).not.toMatch(/import\s+\{\s*AiTab/);
    expect(settingsDialogSource).not.toMatch(/import\s+\{\s*VoiceTab/);
    expect(settingsDialogSource).not.toMatch(/voice\/local\/engines/);
    expect(settingsDialogSource).not.toMatch(/@huggingface\/transformers/);
  });

  it("eager settings tabs do not import AI transport or local voice engines", () => {
    const eager = [
      essentialsSource,
      appearanceSource,
      featuresSource,
      keyboardSource,
      templatesSource,
      dataSource,
      hostedSource,
      diagnosticsSource,
      useSettingsSaveSource,
    ];
    for (const source of eager) {
      expect(source).not.toMatch(/views\/settings\/ai|views\/settings\/voice/);
      expect(source).not.toMatch(/ai\/transport|voice\/local/);
      expect(source).not.toMatch(/@huggingface\/transformers|kokoro-js|piper-tts-web/);
    }
  });

  it("Voice local model card imports manifest data only", () => {
    expect(localModelCardSource).toMatch(/voice\/local\/manifest/);
    expect(localModelCardSource).not.toMatch(
      /voice\/local\/engines|worker-host|verify-fetch|opfs-store|worker-client/,
    );
    expect(localModelCardSource).not.toMatch(
      /@huggingface\/transformers|kokoro-js|piper-tts-web|vad-web/,
    );
  });

  it("Voice tab does not statically import local engines or workers", async () => {
    const voiceTabSource = (await import("../voice/VoiceTab.tsx?raw")).default as string;
    const controllerSource = (await import("../voice/useLocalModelController.ts?raw"))
      .default as string;
    expect(voiceTabSource).not.toMatch(
      /voice\/local\/engines|worker-host|@huggingface\/transformers/,
    );
    expect(controllerSource).toMatch(/import\("\.\.\/\.\.\/\.\.\/voice\/local\/index"\)/);
    expect(controllerSource).not.toMatch(/from\s+["'].*voice\/local\/index["']/);
    expect(controllerSource).not.toMatch(/worker-host|engines\/load-|new Worker/);
  });
});
