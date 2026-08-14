/**
 * Operator plugin transport — authenticated JSON over the shared API client.
 * Parses responses with fail-closed parsers; never logs tokens or package bytes.
 */

import { ApiError, authenticatedJson, type AuthenticatedRequestOptions } from "../api/client";
import {
  parseCommunityPolicy,
  parseContributionList,
  parseGrantList,
  parseInstalledPlugin,
  parseInstalledPluginList,
  parseInvocationResult,
  parseMutationResult,
  parsePluginSettingList,
  parsePublisherList,
  parseRegistryEntry,
  parseRegistryList,
  parseRenderedContribution,
} from "./parsers";
import type {
  CommunityPolicy,
  ContributionFence,
  InstalledPlugin,
  PluginContribution,
  PluginGrant,
  PluginInvocationResult,
  PluginMutationResult,
  PluginPermission,
  PluginSetting,
  PluginSettingValue,
  PublisherTrust,
  RegistryEntry,
  RenderedContribution,
  ScalarNamedValue,
} from "./types";

export type PluginTransportOptions = {
  operationId?: string;
  signal?: AbortSignal;
};

function opts(options?: PluginTransportOptions): AuthenticatedRequestOptions {
  return {
    operationId: options?.operationId,
    signal: options?.signal,
  };
}

function scrubError(error: unknown): Error {
  if (error instanceof ApiError) return error;
  if (error instanceof Error) {
    const message = error.message
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/access_token=[^&\s]+/gi, "access_token=[redacted]");
    return new Error(message);
  }
  return new Error("plugin transport failed");
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw scrubError(error);
  }
}

export async function listPlugins(options?: PluginTransportOptions): Promise<InstalledPlugin[]> {
  return run(async () => {
    const raw = await authenticatedJson<unknown>("/api/v1/plugins", opts(options));
    return parseInstalledPluginList(raw);
  });
}

export async function getPlugin(
  pluginId: string,
  options?: PluginTransportOptions,
): Promise<InstalledPlugin> {
  return run(async () => {
    const raw = await authenticatedJson<unknown>(
      `/api/v1/plugins/${encodeURIComponent(pluginId)}`,
      opts(options),
    );
    return parseInstalledPlugin(raw);
  });
}

export async function getCommunityPolicy(
  options?: PluginTransportOptions,
): Promise<CommunityPolicy> {
  return run(async () => {
    const raw = await authenticatedJson<unknown>("/api/v1/plugins/community-policy", opts(options));
    return parseCommunityPolicy(raw);
  });
}

export async function setCommunityPolicy(
  enabled: boolean,
  options?: PluginTransportOptions,
): Promise<PluginMutationResult> {
  return run(async () => {
    const raw = await authenticatedJson<unknown>("/api/v1/plugins/community-policy", {
      method: "PUT",
      body: { enabled },
      ...opts(options),
    });
    return parseMutationResult(raw);
  });
}

export async function listRegistry(
  params?: { query?: string; capability?: string },
  options?: PluginTransportOptions,
): Promise<{ indexSha256: string; entries: RegistryEntry[] }> {
  return run(async () => {
    const search = new URLSearchParams();
    if (params?.query) search.set("query", params.query);
    if (params?.capability) search.set("capability", params.capability);
    const qs = search.toString();
    const raw = await authenticatedJson<unknown>(
      `/api/v1/plugins/registry${qs ? `?${qs}` : ""}`,
      opts(options),
    );
    return parseRegistryList(raw);
  });
}

export async function getRegistryEntry(
  pluginId: string,
  options?: PluginTransportOptions,
): Promise<RegistryEntry> {
  return run(async () => {
    const raw = await authenticatedJson<unknown>(
      `/api/v1/plugins/registry/${encodeURIComponent(pluginId)}`,
      opts(options),
    );
    return parseRegistryEntry(raw);
  });
}

export async function installRegistryEntry(
  pluginId: string,
  body: {
    version: string;
    expectedPackageSha256: string;
    replaceExisting?: boolean;
    allowDowngrade?: boolean;
  },
  options?: PluginTransportOptions,
): Promise<PluginMutationResult> {
  return run(async () => {
    const raw = await authenticatedJson<unknown>(
      `/api/v1/plugins/registry/${encodeURIComponent(pluginId)}/install`,
      {
        method: "POST",
        body: {
          version: body.version,
          expected_package_sha256: body.expectedPackageSha256,
          replace_existing: body.replaceExisting ?? false,
          allow_downgrade: body.allowDowngrade ?? false,
        },
        ...opts(options),
      },
    );
    return parseMutationResult(raw);
  });
}

export async function enablePlugin(
  pluginId: string,
  options?: PluginTransportOptions,
): Promise<PluginMutationResult> {
  return run(async () => {
    const raw = await authenticatedJson<unknown>(
      `/api/v1/plugins/${encodeURIComponent(pluginId)}/enable`,
      { method: "POST", ...opts(options) },
    );
    return parseMutationResult(raw);
  });
}

export async function disablePlugin(
  pluginId: string,
  options?: PluginTransportOptions,
): Promise<PluginMutationResult> {
  return run(async () => {
    const raw = await authenticatedJson<unknown>(
      `/api/v1/plugins/${encodeURIComponent(pluginId)}/disable`,
      { method: "POST", ...opts(options) },
    );
    return parseMutationResult(raw);
  });
}

export async function retryPlugin(
  pluginId: string,
  options?: PluginTransportOptions,
): Promise<PluginMutationResult> {
  return run(async () => {
    const raw = await authenticatedJson<unknown>(
      `/api/v1/plugins/${encodeURIComponent(pluginId)}/retry`,
      { method: "POST", ...opts(options) },
    );
    return parseMutationResult(raw);
  });
}

export async function uninstallPlugin(
  pluginId: string,
  options?: PluginTransportOptions,
): Promise<PluginMutationResult> {
  return run(async () => {
    const raw = await authenticatedJson<unknown>(
      `/api/v1/plugins/${encodeURIComponent(pluginId)}`,
      { method: "DELETE", ...opts(options) },
    );
    return parseMutationResult(raw);
  });
}

export async function listGrants(
  pluginId: string,
  options?: PluginTransportOptions,
): Promise<PluginGrant[]> {
  return run(async () => {
    const raw = await authenticatedJson<unknown>(
      `/api/v1/plugins/${encodeURIComponent(pluginId)}/grants`,
      opts(options),
    );
    return parseGrantList(raw);
  });
}

export async function replaceGrants(
  pluginId: string,
  packageGeneration: number,
  permissions: PluginPermission[],
  options?: PluginTransportOptions,
): Promise<PluginMutationResult> {
  return run(async () => {
    const raw = await authenticatedJson<unknown>(
      `/api/v1/plugins/${encodeURIComponent(pluginId)}/grants`,
      {
        method: "PUT",
        body: {
          package_generation: packageGeneration,
          permissions: permissions.map((p) => ({
            capability: p.capability,
            scope: p.scope ?? {},
          })),
        },
        ...opts(options),
      },
    );
    return parseMutationResult(raw);
  });
}

export async function revokeGrants(
  pluginId: string,
  packageGeneration: number,
  options?: PluginTransportOptions,
): Promise<PluginMutationResult> {
  return run(async () => {
    const raw = await authenticatedJson<unknown>(
      `/api/v1/plugins/${encodeURIComponent(pluginId)}/grants?package_generation=${packageGeneration}`,
      { method: "DELETE", ...opts(options) },
    );
    return parseMutationResult(raw);
  });
}

export async function listPluginSettings(
  pluginId: string,
  options?: PluginTransportOptions,
): Promise<PluginSetting[]> {
  return run(async () => {
    const raw = await authenticatedJson<unknown>(
      `/api/v1/plugins/${encodeURIComponent(pluginId)}/settings`,
      opts(options),
    );
    return parsePluginSettingList(raw);
  });
}

export async function setPluginSetting(
  pluginId: string,
  key: string,
  packageGeneration: number,
  value: PluginSettingValue,
  options?: PluginTransportOptions,
): Promise<PluginMutationResult> {
  return run(async () => {
    const raw = await authenticatedJson<unknown>(
      `/api/v1/plugins/${encodeURIComponent(pluginId)}/settings/${encodeURIComponent(key)}`,
      {
        method: "PUT",
        body: { package_generation: packageGeneration, value },
        ...opts(options),
      },
    );
    return parseMutationResult(raw);
  });
}

export async function deletePluginSetting(
  pluginId: string,
  key: string,
  packageGeneration: number,
  options?: PluginTransportOptions,
): Promise<PluginMutationResult> {
  return run(async () => {
    const raw = await authenticatedJson<unknown>(
      `/api/v1/plugins/${encodeURIComponent(pluginId)}/settings/${encodeURIComponent(key)}?package_generation=${packageGeneration}`,
      { method: "DELETE", ...opts(options) },
    );
    return parseMutationResult(raw);
  });
}

export async function listContributions(
  options?: PluginTransportOptions,
): Promise<PluginContribution[]> {
  return run(async () => {
    const raw = await authenticatedJson<unknown>("/api/v1/plugins/contributions", opts(options));
    return parseContributionList(raw);
  });
}

export async function renderSurface(
  pluginId: string,
  surfaceId: string,
  fence: ContributionFence,
  options?: PluginTransportOptions,
): Promise<RenderedContribution> {
  return run(async () => {
    const raw = await authenticatedJson<unknown>(
      `/api/v1/plugins/${encodeURIComponent(pluginId)}/surfaces/${encodeURIComponent(surfaceId)}/render`,
      {
        method: "POST",
        body: {
          package_generation: fence.packageGeneration,
          activation_epoch: fence.activationEpoch,
          host_session_id: fence.hostSessionId,
        },
        ...opts(options),
      },
    );
    return parseRenderedContribution(raw);
  });
}

export async function invokeSurfaceAction(
  pluginId: string,
  surfaceId: string,
  actionId: string,
  fence: ContributionFence,
  values: ScalarNamedValue[] = [],
  options?: PluginTransportOptions,
): Promise<PluginInvocationResult> {
  return run(async () => {
    const raw = await authenticatedJson<unknown>(
      `/api/v1/plugins/${encodeURIComponent(pluginId)}/surfaces/${encodeURIComponent(surfaceId)}/actions/${encodeURIComponent(actionId)}`,
      {
        method: "POST",
        body: {
          package_generation: fence.packageGeneration,
          activation_epoch: fence.activationEpoch,
          host_session_id: fence.hostSessionId,
          values: values.map((v) => ({ name: v.name, value: v.value })),
        },
        ...opts(options),
      },
    );
    return parseInvocationResult(raw);
  });
}

export async function invokeCommand(
  pluginId: string,
  commandId: string,
  fence: ContributionFence,
  values: unknown[] = [],
  options?: PluginTransportOptions,
): Promise<PluginInvocationResult> {
  return run(async () => {
    const raw = await authenticatedJson<unknown>(
      `/api/v1/plugins/${encodeURIComponent(pluginId)}/commands/${encodeURIComponent(commandId)}`,
      {
        method: "POST",
        body: {
          package_generation: fence.packageGeneration,
          activation_epoch: fence.activationEpoch,
          host_session_id: fence.hostSessionId,
          values,
        },
        ...opts(options),
      },
    );
    return parseInvocationResult(raw);
  });
}

export async function listPublishers(options?: PluginTransportOptions): Promise<PublisherTrust[]> {
  return run(async () => {
    const raw = await authenticatedJson<unknown>("/api/v1/plugins/publishers", opts(options));
    return parsePublisherList(raw);
  });
}
