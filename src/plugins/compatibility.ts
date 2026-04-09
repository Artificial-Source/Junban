import { APP_VERSION } from "../config/defaults.js";
import { PLUGIN_API_VERSION } from "./api.js";

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export interface PluginCompatibilityIssue {
  field: "minJunbanVersion" | "targetApiVersion" | "dependencies";
  message: string;
}

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

function parseSemVer(value: string): SemVer | null {
  const match = SEMVER_PATTERN.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function validateManifestVersionCompatibility(manifest: {
  id: string;
  minJunbanVersion: string;
  targetApiVersion?: string;
}): PluginCompatibilityIssue[] {
  const issues: PluginCompatibilityIssue[] = [];

  const minJunban = parseSemVer(manifest.minJunbanVersion);
  const currentJunban = parseSemVer(APP_VERSION);
  if (!minJunban) {
    issues.push({
      field: "minJunbanVersion",
      message: `Plugin "${manifest.id}" has invalid minJunbanVersion "${manifest.minJunbanVersion}"; expected semver (x.y.z)`,
    });
  } else if (!currentJunban) {
    issues.push({
      field: "minJunbanVersion",
      message: `Host APP_VERSION "${APP_VERSION}" is not valid semver`,
    });
  } else if (compareSemVer(minJunban, currentJunban) > 0) {
    issues.push({
      field: "minJunbanVersion",
      message: `Plugin "${manifest.id}" requires Junban >= ${manifest.minJunbanVersion} but current is ${APP_VERSION}`,
    });
  }

  if (manifest.targetApiVersion) {
    const target = parseSemVer(manifest.targetApiVersion);
    const currentApi = parseSemVer(PLUGIN_API_VERSION);
    if (!target) {
      issues.push({
        field: "targetApiVersion",
        message: `Plugin "${manifest.id}" has invalid targetApiVersion "${manifest.targetApiVersion}"; expected semver (x.y.z)`,
      });
    } else if (!currentApi) {
      issues.push({
        field: "targetApiVersion",
        message: `Host PLUGIN_API_VERSION "${PLUGIN_API_VERSION}" is not valid semver`,
      });
    } else if (target.major !== currentApi.major) {
      issues.push({
        field: "targetApiVersion",
        message: `Plugin "${manifest.id}" targets Plugin API ${manifest.targetApiVersion} (major ${target.major}) but current API is ${PLUGIN_API_VERSION} (major ${currentApi.major})`,
      });
    }
  }

  return issues;
}

export function checkDependencyVersionConstraint(
  actualVersion: string,
  constraint: string,
): { ok: boolean; error?: string } {
  const actual = parseSemVer(actualVersion);
  if (!actual) {
    return { ok: false, error: `Dependency version "${actualVersion}" is not valid semver` };
  }

  const trimmed = constraint.trim();
  if (!trimmed) {
    return { ok: false, error: "Dependency version constraint cannot be empty" };
  }

  const match = /^(<=|>=|<|>|=|\^|~)?\s*(\d+\.\d+\.\d+(?:[-+].*)?)$/.exec(trimmed);
  if (!match) {
    return {
      ok: false,
      error: `Unsupported dependency constraint "${constraint}" (supported: exact x.y.z, ^, ~, <, <=, >, >=, =)`,
    };
  }

  const operator = match[1] ?? "=";
  const expected = parseSemVer(match[2]);
  if (!expected) {
    return {
      ok: false,
      error: `Dependency constraint version "${match[2]}" is not valid semver`,
    };
  }

  const cmp = compareSemVer(actual, expected);

  if (operator === "=") {
    return { ok: cmp === 0 };
  }
  if (operator === ">=") {
    return { ok: cmp >= 0 };
  }
  if (operator === ">") {
    return { ok: cmp > 0 };
  }
  if (operator === "<=") {
    return { ok: cmp <= 0 };
  }
  if (operator === "<") {
    return { ok: cmp < 0 };
  }
  if (operator === "^") {
    return { ok: actual.major === expected.major && cmp >= 0 };
  }
  if (operator === "~") {
    return {
      ok:
        actual.major === expected.major &&
        actual.minor === expected.minor &&
        cmp >= 0,
    };
  }

  return {
    ok: false,
    error: `Unsupported dependency operator "${operator}"`,
  };
}
