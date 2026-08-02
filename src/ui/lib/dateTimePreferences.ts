/**
 * Confirmed server date/time display preferences.
 * Only WorkspaceContext may update these after authoritative settings load/patch.
 */

export type DateFormatPreference = "relative" | "short" | "long" | "iso";
export type TimeFormatPreference = "h12" | "h24";

/** Phase 3-preserving defaults: Short date, 24-hour time. */
const DEFAULT_DATE_FORMAT: DateFormatPreference = "short";
const DEFAULT_TIME_FORMAT: TimeFormatPreference = "h24";

let dateFormat: DateFormatPreference = DEFAULT_DATE_FORMAT;
let timeFormat: TimeFormatPreference = DEFAULT_TIME_FORMAT;

/** Apply confirmed server date/time display preferences. */
export function setConfirmedDateTimePreferences(prefs: {
  dateFormat: DateFormatPreference;
  timeFormat: TimeFormatPreference;
}): void {
  dateFormat = prefs.dateFormat;
  timeFormat = prefs.timeFormat;
}

/** Read the active confirmed date format (default Short). */
export function getConfirmedDateFormat(): DateFormatPreference {
  return dateFormat;
}

/** Read the active confirmed time format (default H24). */
export function getConfirmedTimeFormat(): TimeFormatPreference {
  return timeFormat;
}

/** Test-only reset so module state does not leak across cases. */
export function resetDateTimePreferencesForTests(): void {
  dateFormat = DEFAULT_DATE_FORMAT;
  timeFormat = DEFAULT_TIME_FORMAT;
}
