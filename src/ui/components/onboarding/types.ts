import type { GeneralSettings } from "../../context/SettingsContext.js";

export interface OnboardingModalProps {
  open: boolean;
  onComplete: () => void;
  onRequestOpenSettings?: (tab: string) => void;
  mutationsBlocked?: boolean;
  /** Explicit readOnly flag from settings context. If true, final writes are skipped. */
  readOnly?: boolean;
}

export type ThemeId = "light" | "dark" | "nord";
export type Preset = "minimal" | "standard" | "power";

export interface ThemeOption {
  id: ThemeId;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  iconColor: string;
  cardBg: string;
  labelColor: string;
  mockBg: string;
  barColor: string;
  accentBar: string;
}

export interface PresetOption {
  key: Preset;
  label: string;
  description: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

export type PresetSettings = Record<Preset, Partial<Record<keyof GeneralSettings, string>>>;
