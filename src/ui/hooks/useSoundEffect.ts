import { useCallback } from "react";
import { useGeneralSettings } from "../context/SettingsContext.js";
import { playSound as playSoundRaw, type SoundEvent } from "../../utils/sounds.js";

const EVENT_SETTING_KEY: Record<
  SoundEvent,
  "sound_complete" | "sound_create" | "sound_delete" | "sound_reminder"
> = {
  complete: "sound_complete",
  create: "sound_create",
  delete: "sound_delete",
  reminder: "sound_reminder",
};

export function useSoundEffect() {
  const { settings } = useGeneralSettings();

  const play = useCallback(
    (event: SoundEvent) => {
      if (settings.sound_enabled !== "true") return;
      if (settings[EVENT_SETTING_KEY[event]] !== "true") return;
      const volume = parseInt(settings.sound_volume, 10);
      if (isNaN(volume) || volume <= 0) return;
      playSoundRaw(event, volume / 100).catch(() => {});
    },
    [settings],
  );

  return play;
}
