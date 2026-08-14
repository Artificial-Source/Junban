/**
 * Fail-closed parsers for plugin operator payloads and declarative UI.
 * Unknown fields / bounds violations reject the whole value.
 */

import {
  FIRST_PARTY_COMMAND_IDS,
  FIRST_PARTY_ROUTE_NAMES,
  UI_DEPTH_MAX,
  UI_NODE_MAX,
  UI_SURFACE_BYTES_MAX,
  UI_TEXT_MAX,
  type CommunityPolicy,
  type ContributionFence,
  type InstalledPlugin,
  type PluginCapability,
  type PluginContribution,
  type PluginGrant,
  type PluginPermission,
  type PluginPermissionScope,
  type PluginSetting,
  type PluginSettingValue,
  type PluginSurface,
  type PluginMutationResult,
  type PluginInvocationResult,
  type PublisherTrust,
  type RegistryEntry,
  type RenderedContribution,
  type ScalarNamedValue,
  type ScalarValue,
  type SettingDeclaration,
  type SettingSchema,
  type UiAlign,
  type UiContent,
  type UiNode,
  type UiSize,
  type UiTone,
} from "./types";

const CAPABILITIES = new Set<string>([
  "tasks:read",
  "tasks:write",
  "projects:read",
  "projects:write",
  "tags:read",
  "tags:write",
  "events:subscribe",
  "settings",
  "storage",
  "commands",
  "ui:view",
  "ui:panel",
  "ui:status",
  "services:provide",
  "services:consume",
  "http",
  "logging",
]);

const PLUGIN_EVENT_KINDS = new Set([
  "project-created",
  "project-deleted",
  "project-updated",
  "section-created",
  "section-deleted",
  "section-updated",
  "tag-created",
  "tag-deleted",
  "tag-updated",
  "task-cancelled",
  "task-completed",
  "task-created",
  "task-deleted",
  "task-reopened",
  "task-uncompleted",
  "task-updated",
]);
const PLUGIN_HTTP_METHODS = new Set(["DELETE", "GET", "PATCH", "POST", "PUT"]);
const UI_TONES = new Set(["neutral", "accent", "positive", "warning", "danger"]);
const UI_SIZES = new Set(["small", "medium", "large"]);
const UI_ALIGNS = new Set(["start", "center", "end", "stretch"]);

const BUNDLED_BUILTIN_IDS = new Set([
  "pomodoro",
  "pomodoro-rust",
  "junban-pomodoro",
  "automation-rust",
  "import-typescript",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`invalid ${field}`);
  return value;
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("invalid optional string");
  return value;
}

function requireInt(value: unknown, field: string): number {
  if (!isFiniteNumber(value) || !Number.isInteger(value)) throw new Error(`invalid ${field}`);
  return value;
}

function requireBool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`invalid ${field}`);
  return value;
}

function parseCapability(value: unknown): PluginCapability {
  if (typeof value !== "string" || !CAPABILITIES.has(value)) {
    throw new Error("unknown plugin capability");
  }
  return value as PluginCapability;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parsePermissionScope(raw: unknown): PluginPermissionScope {
  if (!isObject(raw)) throw new Error("invalid permission scope");
  if (Object.keys(raw).length === 0) return {};

  if (hasOnlyKeys(raw, ["event_kinds"]) && Array.isArray(raw.event_kinds)) {
    const eventKinds = raw.event_kinds.map((kind) => requireString(kind, "event kind"));
    if (eventKinds.some((kind) => !PLUGIN_EVENT_KINDS.has(kind))) {
      throw new Error("unknown plugin event kind");
    }
    return { event_kinds: eventKinds } as PluginPermissionScope;
  }

  if (hasOnlyKeys(raw, ["services"]) && Array.isArray(raw.services)) {
    const services = raw.services.map((service) => {
      if (!isObject(service) || !hasOnlyKeys(service, ["plugin_id", "service_id"])) {
        throw new Error("invalid plugin service scope");
      }
      return {
        plugin_id: requireString(service.plugin_id, "service plugin_id"),
        service_id: requireString(service.service_id, "service service_id"),
      };
    });
    return { services };
  }

  if (
    hasOnlyKeys(raw, ["origins", "methods"]) &&
    Array.isArray(raw.origins) &&
    Array.isArray(raw.methods)
  ) {
    const origins = raw.origins.map((origin) => requireString(origin, "HTTP origin"));
    const methods = raw.methods.map((method) => requireString(method, "HTTP method"));
    if (methods.some((method) => !PLUGIN_HTTP_METHODS.has(method))) {
      throw new Error("unknown plugin HTTP method");
    }
    return { origins, methods } as PluginPermissionScope;
  }

  throw new Error("invalid permission scope");
}

export function parsePermission(raw: unknown): PluginPermission {
  if (!isObject(raw)) throw new Error("invalid permission");
  const capability = parseCapability(raw.capability);
  const scope = parsePermissionScope(raw.scope);
  const scopedCorrectly =
    (capability === "events:subscribe" && "event_kinds" in scope) ||
    (capability === "services:consume" && "services" in scope) ||
    (capability === "http" && "origins" in scope && "methods" in scope) ||
    (!new Set(["events:subscribe", "services:consume", "http"]).has(capability) &&
      Object.keys(scope).length === 0);
  if (!scopedCorrectly) throw new Error("permission capability and scope do not match");
  return { capability, scope };
}

function parsePermissions(raw: unknown): PluginPermission[] {
  if (!Array.isArray(raw)) throw new Error("invalid permissions");
  return raw.map(parsePermission);
}

/** True when the package is a bundled/reference plugin shown under Built-in. */
export function isBuiltinPluginId(pluginId: string, publisherKeyId?: string): boolean {
  if (BUNDLED_BUILTIN_IDS.has(pluginId)) return true;
  if (pluginId.startsWith("junban.")) return true;
  if (publisherKeyId && publisherKeyId.startsWith("junban-builtin")) return true;
  return false;
}

export function parseInstalledPlugin(raw: unknown): InstalledPlugin {
  if (!isObject(raw)) throw new Error("invalid installed plugin");
  const pluginId = requireString(raw.plugin_id, "plugin_id");
  const publisherKeyId = requireString(raw.publisher_key_id, "publisher_key_id");
  return {
    pluginId,
    name: requireString(raw.name, "name"),
    description: requireString(raw.description, "description"),
    version: requireString(raw.version, "version"),
    packageSha256: requireString(raw.package_sha256, "package_sha256"),
    publisherKeyId,
    packageGeneration: requireInt(raw.package_generation, "package_generation"),
    activationEpoch: requireInt(raw.activation_epoch, "activation_epoch"),
    desiredEnabled: requireBool(raw.desired_enabled, "desired_enabled"),
    runtimeState: requireString(raw.runtime_state, "runtime_state"),
    requestedPermissions: parsePermissions(raw.requested_permissions),
    grantedPermissions: parsePermissions(raw.granted_permissions),
    dependencies: Array.isArray(raw.dependencies)
      ? raw.dependencies.map((d) => requireString(d, "dependency"))
      : [],
    dependenciesSatisfied: requireBool(raw.dependencies_satisfied, "dependencies_satisfied"),
    settingDeclarations: parseSettingDeclarations(raw.settings),
    failureCount: requireInt(raw.failure_count, "failure_count"),
    lastErrorCode: optionalString(raw.last_error_code),
    nextRetryAt: optionalString(raw.next_retry_at),
    installedAt: requireString(raw.installed_at, "installed_at"),
    updatedAt: requireString(raw.updated_at, "updated_at"),
    builtin: isBuiltinPluginId(pluginId, publisherKeyId),
  };
}

export function parseInstalledPluginList(raw: unknown): InstalledPlugin[] {
  if (!isObject(raw) || !Array.isArray(raw.plugins)) throw new Error("invalid plugin list");
  return raw.plugins.map(parseInstalledPlugin);
}

export function parseCommunityPolicy(raw: unknown): CommunityPolicy {
  if (!isObject(raw)) throw new Error("invalid community policy");
  return {
    enabled: requireBool(raw.enabled, "enabled"),
    updatedAt: requireString(raw.updated_at, "updated_at"),
  };
}

export function parseRegistryEntry(raw: unknown): RegistryEntry {
  if (!isObject(raw)) throw new Error("invalid registry entry");
  return {
    pluginId: requireString(raw.plugin_id, "plugin_id"),
    version: requireString(raw.version, "version"),
    packageSha256: requireString(raw.package_sha256, "package_sha256"),
    packageSize: requireInt(raw.package_size, "package_size"),
    publisherKeyId: requireString(raw.publisher_key_id, "publisher_key_id"),
    name: requireString(raw.name, "name"),
    description: requireString(raw.description, "description"),
    author: requireString(raw.author, "author"),
    license: requireString(raw.license, "license"),
    searchTags: Array.isArray(raw.search_tags)
      ? raw.search_tags.map((t) => requireString(t, "tag"))
      : [],
    runtimeProfile: requireString(raw.runtime_profile, "runtime_profile"),
    requestedCapabilities: Array.isArray(raw.requested_capabilities)
      ? raw.requested_capabilities.map((c) => requireString(c, "capability"))
      : [],
  };
}

export function parseRegistryList(raw: unknown): { indexSha256: string; entries: RegistryEntry[] } {
  if (!isObject(raw) || !Array.isArray(raw.entries)) throw new Error("invalid registry list");
  return {
    indexSha256: requireString(raw.index_sha256, "index_sha256"),
    entries: raw.entries.map(parseRegistryEntry),
  };
}

export function parseContribution(raw: unknown): PluginContribution {
  if (!isObject(raw)) throw new Error("invalid contribution");
  const pluginId = requireString(raw.plugin_id, "plugin_id");
  const localId = requireString(raw.local_id, "local_id");
  const kind = requireString(raw.kind, "kind");
  const contributionId = requireString(raw.contribution_id, "contribution_id");

  // Fail closed: never admit contributions that would shadow first-party routes/commands.
  if (kind === "command") {
    if (FIRST_PARTY_COMMAND_IDS.has(localId) || FIRST_PARTY_COMMAND_IDS.has(contributionId)) {
      throw new Error("plugin command shadows first-party command");
    }
  }
  if (kind === "view") {
    const routeCandidate = localId.toLowerCase();
    if (FIRST_PARTY_ROUTE_NAMES.has(routeCandidate)) {
      throw new Error("plugin view shadows first-party route");
    }
  }

  return {
    contributionId,
    pluginId,
    localId,
    kind,
    title: requireString(raw.title, "title"),
    description: optionalString(raw.description),
    location: optionalString(raw.location),
    actions: Array.isArray(raw.actions) ? raw.actions.map((a) => requireString(a, "action")) : [],
    packageGeneration: requireInt(raw.package_generation, "package_generation"),
    activationEpoch: requireInt(raw.activation_epoch, "activation_epoch"),
    hostSessionId: requireString(raw.host_session_id, "host_session_id"),
  };
}

export function parseContributionList(raw: unknown): PluginContribution[] {
  if (!isObject(raw) || !Array.isArray(raw.contributions)) {
    throw new Error("invalid contribution list");
  }
  const out: PluginContribution[] = [];
  for (const item of raw.contributions) {
    try {
      out.push(parseContribution(item));
    } catch {
      // Drop only the bad contribution; keep the rest of the server-confirmed set.
    }
  }
  return out;
}

export function fenceFromContribution(c: PluginContribution): ContributionFence {
  return {
    packageGeneration: c.packageGeneration,
    activationEpoch: c.activationEpoch,
    hostSessionId: c.hostSessionId,
  };
}

export function parseSettingValue(raw: unknown): PluginSettingValue {
  if (typeof raw === "string" || typeof raw === "boolean") return raw;
  if (isFiniteNumber(raw) && Number.isInteger(raw)) return raw;
  throw new Error("invalid setting value");
}

export function parsePluginSetting(raw: unknown): PluginSetting {
  if (!isObject(raw)) throw new Error("invalid plugin setting");
  return {
    key: requireString(raw.key, "key"),
    value: parseSettingValue(raw.value),
    updatedAt: requireString(raw.updated_at, "updated_at"),
  };
}

export function parsePluginSettingList(raw: unknown): PluginSetting[] {
  if (!isObject(raw) || !Array.isArray(raw.settings)) throw new Error("invalid setting list");
  return raw.settings.map(parsePluginSetting);
}

function parseSettingSchema(raw: unknown): SettingSchema {
  if (!isObject(raw)) throw new Error("invalid setting schema");
  const type = requireString(raw.type, "type");
  switch (type) {
    case "text": {
      const secret = requireBool(raw.secret, "secret");
      const common = {
        type: "text" as const,
        minBytes: requireInt(raw.min_bytes, "min_bytes"),
        maxBytes: requireInt(raw.max_bytes, "max_bytes"),
      };
      if (secret) {
        if (raw.default !== undefined && raw.default !== null) {
          throw new Error("secret setting default must not be exposed");
        }
        return { ...common, default: null, secret: true };
      }
      return {
        ...common,
        default: requireString(raw.default, "default"),
        secret: false,
      };
    }
    case "integer":
      return {
        type: "integer",
        default: requireInt(raw.default, "default"),
        min: requireInt(raw.min, "min"),
        max: requireInt(raw.max, "max"),
        step: requireInt(raw.step, "step"),
      };
    case "boolean":
      return {
        type: "boolean",
        default: requireBool(raw.default, "default"),
      };
    case "select": {
      if (!Array.isArray(raw.options)) throw new Error("invalid select options");
      return {
        type: "select",
        default: requireString(raw.default, "default"),
        options: raw.options.map((opt) => {
          if (!isObject(opt)) throw new Error("invalid select option");
          return {
            id: requireString(opt.id, "option.id"),
            label: requireString(opt.label, "option.label"),
          };
        }),
      };
    }
    default:
      throw new Error("unknown setting schema type");
  }
}

/** Parse manifest setting declarations returned with installed plugin authority. */
export function parseSettingDeclarations(raw: unknown): SettingDeclaration[] {
  if (!Array.isArray(raw)) throw new Error("invalid settings declarations");
  return raw.map((item) => {
    if (!isObject(item)) throw new Error("invalid setting declaration");
    return {
      id: requireString(item.id, "id"),
      label: requireString(item.label, "label"),
      description: requireString(item.description, "description"),
      schema: parseSettingSchema(item.schema),
    };
  });
}

export function parseGrant(raw: unknown): PluginGrant {
  if (!isObject(raw)) throw new Error("invalid grant");
  return {
    packageGeneration: requireInt(raw.package_generation, "package_generation"),
    permissionHash: requireString(raw.permission_hash, "permission_hash"),
    permission: parsePermission(raw.permission),
    grantedAt: requireString(raw.granted_at, "granted_at"),
  };
}

export function parseGrantList(raw: unknown): PluginGrant[] {
  if (!isObject(raw) || !Array.isArray(raw.grants)) throw new Error("invalid grant list");
  return raw.grants.map(parseGrant);
}

export function parsePublisher(raw: unknown): PublisherTrust {
  if (!isObject(raw)) throw new Error("invalid publisher");
  return {
    keyId: requireString(raw.key_id, "key_id"),
    publicKeyBase64: requireString(raw.public_key_base64, "public_key_base64"),
    status: requireString(raw.status, "status"),
    trustedAt: requireString(raw.trusted_at, "trusted_at"),
    revokedAt: optionalString(raw.revoked_at),
  };
}

export function parsePublisherList(raw: unknown): PublisherTrust[] {
  if (!isObject(raw) || !Array.isArray(raw.publishers)) throw new Error("invalid publisher list");
  return raw.publishers.map(parsePublisher);
}

export function parseMutationResult(raw: unknown): PluginMutationResult {
  if (!isObject(raw) || !isObject(raw.event)) throw new Error("invalid mutation response");
  const event = raw.event;
  return {
    eventType: requireString(event.event_type, "event_type"),
    revision: requireInt(event.revision, "revision"),
    operationId: requireString(event.operation_id, "operation_id"),
  };
}

export function parseInvocationResult(raw: unknown): PluginInvocationResult {
  if (!isObject(raw)) throw new Error("invalid invocation response");
  return {
    status: requireString(raw.status, "status"),
    terminalKind: optionalString(raw.terminal_kind),
    revision:
      raw.revision === null || raw.revision === undefined
        ? null
        : requireInt(raw.revision, "revision"),
    rejection: optionalString(raw.rejection),
  };
}

function parseTone(value: unknown): UiTone {
  if (typeof value !== "string" || !UI_TONES.has(value)) throw new Error("invalid ui tone");
  return value as UiTone;
}

function parseSize(value: unknown): UiSize {
  if (typeof value !== "string" || !UI_SIZES.has(value)) throw new Error("invalid ui size");
  return value as UiSize;
}

function parseAlign(value: unknown): UiAlign {
  if (typeof value !== "string" || !UI_ALIGNS.has(value)) throw new Error("invalid ui align");
  return value as UiAlign;
}

function boundText(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (text.length > UI_TEXT_MAX) throw new Error(`${field} exceeds text bound`);
  // Reject control characters except common whitespace.
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      throw new Error(`${field} contains control characters`);
    }
  }
  return text;
}

function parseScalarValue(raw: unknown): ScalarValue {
  if (!isObject(raw)) throw new Error("invalid scalar");
  const tag = requireString(raw.tag, "scalar.tag");
  switch (tag) {
    case "string-value":
      return { tag, val: boundText(raw.val, "scalar.val") };
    case "integer-value":
      return { tag, val: requireInt(raw.val, "scalar.val") };
    case "boolean-value":
      return { tag, val: requireBool(raw.val, "scalar.val") };
    case "date-value":
    case "timestamp-value":
    case "task-id":
    case "project-id":
    case "tag-id":
    case "plugin-id":
    case "option-id":
      return { tag, val: boundText(raw.val, "scalar.val") };
    default:
      throw new Error("unknown scalar tag");
  }
}

function parseScalarNamedValues(raw: unknown): ScalarNamedValue[] {
  if (!Array.isArray(raw)) throw new Error("invalid named values");
  if (raw.length > 32) throw new Error("too many named values");
  return raw.map((item) => {
    if (!isObject(item)) throw new Error("invalid named value");
    return {
      name: boundText(item.name, "name"),
      value: parseScalarValue(item.value),
    };
  });
}

function parseLayout(raw: unknown): { gap: number; align: UiAlign } {
  if (!isObject(raw)) throw new Error("invalid layout");
  const gap = requireInt(raw.gap, "gap");
  if (gap < 0 || gap > 64) throw new Error("layout gap out of range");
  return { gap, align: parseAlign(raw.align) };
}

function parseTextProps(raw: unknown): { text: string; tone: UiTone; size: UiSize } {
  if (!isObject(raw)) throw new Error("invalid text props");
  return {
    text: boundText(raw.text, "text"),
    tone: parseTone(raw.tone),
    size: parseSize(raw.size),
  };
}

function parseInputProps(raw: unknown): {
  label: string;
  actionId: string;
  value: ScalarValue;
  options: ScalarNamedValue[];
} {
  if (!isObject(raw)) throw new Error("invalid input props");
  return {
    label: boundText(raw.label, "label"),
    actionId: boundText(raw["action-id"], "action-id"),
    value: parseScalarValue(raw.value),
    options: parseScalarNamedValues(raw.options),
  };
}

function parseUiContent(raw: unknown): UiContent {
  if (!isObject(raw)) throw new Error("invalid ui content");
  const tag = requireString(raw.tag, "content.tag");
  const val = raw.val;
  switch (tag) {
    case "stack":
      return { tag, val: parseLayout(val) };
    case "row":
      return { tag, val: parseLayout(val) };
    case "heading":
    case "text":
    case "badge":
    case "empty-state":
    case "error-state":
      return { tag, val: parseTextProps(val) };
    case "metric": {
      if (!isObject(val)) throw new Error("invalid metric");
      return {
        tag,
        val: {
          label: boundText(val.label, "label"),
          value: boundText(val.value, "value"),
          tone: parseTone(val.tone),
        },
      };
    }
    case "progress": {
      if (!isObject(val)) throw new Error("invalid progress");
      const value = requireInt(val.value, "value");
      const maximum = requireInt(val.maximum, "maximum");
      if (value < 0 || maximum <= 0 || value > maximum) throw new Error("progress out of range");
      return {
        tag,
        val: {
          label: boundText(val.label, "label"),
          value,
          maximum,
        },
      };
    }
    case "button": {
      if (!isObject(val)) throw new Error("invalid button");
      return {
        tag,
        val: {
          label: boundText(val.label, "label"),
          actionId: boundText(val["action-id"], "action-id"),
          tone: parseTone(val.tone),
          icon: val.icon === undefined || val.icon === null ? null : boundText(val.icon, "icon"),
        },
      };
    }
    case "text-input":
    case "number-input":
    case "select":
    case "toggle":
      return { tag, val: parseInputProps(val) };
    case "task-list": {
      if (!isObject(val) || !Array.isArray(val["task-ids"])) throw new Error("invalid task-list");
      const taskIds = val["task-ids"].map((id) => boundText(id, "task-id"));
      if (taskIds.length > 64) throw new Error("task-list too large");
      return { tag, val: { taskIds } };
    }
    case "task-ref":
      return { tag, val: boundText(val, "task-ref") };
    case "divider":
      return { tag, val: null };
    default:
      throw new Error("unknown ui content tag");
  }
}

function parseUiNode(raw: unknown): UiNode {
  if (!isObject(raw)) throw new Error("invalid ui node");
  const parentRaw = raw["parent-index"];
  let parentIndex: number | null = null;
  if (parentRaw !== undefined && parentRaw !== null) {
    parentIndex = requireInt(parentRaw, "parent-index");
  }
  return {
    id: boundText(raw.id, "id"),
    parentIndex,
    content: parseUiContent(raw.content),
  };
}

/**
 * Parse and validate a WIT-authority surface (flat preorder node array).
 * Rejects unknown tags, cycles, depth/node/text/byte bounds, and missing roots.
 */
export function parsePluginSurface(raw: unknown): PluginSurface {
  const encoded = JSON.stringify(raw);
  if (encoded.length > UI_SURFACE_BYTES_MAX) {
    throw new Error("surface exceeds serialized size bound");
  }
  if (!isObject(raw)) throw new Error("invalid surface");
  const surfaceId = boundText(raw["surface-id"], "surface-id");
  const rootIndex = requireInt(raw["root-index"], "root-index");
  if (!Array.isArray(raw.nodes)) throw new Error("invalid surface nodes");
  if (raw.nodes.length === 0 || raw.nodes.length > UI_NODE_MAX) {
    throw new Error("surface node count out of bounds");
  }
  if (rootIndex < 0 || rootIndex >= raw.nodes.length) {
    throw new Error("surface root-index out of range");
  }

  const nodes = raw.nodes.map(parseUiNode);
  const ids = new Set<string>();
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]!;
    if (ids.has(node.id)) throw new Error("duplicate ui node id");
    ids.add(node.id);
    if (i === rootIndex) {
      if (node.parentIndex !== null) throw new Error("root must have no parent");
    } else {
      if (node.parentIndex === null) throw new Error("non-root requires parent");
      if (node.parentIndex < 0 || node.parentIndex >= i) {
        throw new Error("parent-index must be lower than node index");
      }
    }
  }

  // Depth check from each node walking parents.
  for (let i = 0; i < nodes.length; i += 1) {
    let depth = 0;
    let cursor: number | null = i;
    const seen = new Set<number>();
    while (cursor !== null) {
      if (seen.has(cursor)) throw new Error("ui node cycle");
      seen.add(cursor);
      depth += 1;
      if (depth > UI_DEPTH_MAX) throw new Error("ui depth exceeds bound");
      cursor = nodes[cursor]!.parentIndex;
    }
  }

  return { surfaceId, rootIndex, nodes };
}

export function parseRenderedContribution(raw: unknown): RenderedContribution {
  if (!isObject(raw)) throw new Error("invalid render response");
  return {
    pluginId: requireString(raw.plugin_id, "plugin_id"),
    surfaceId: requireString(raw.surface_id, "surface_id"),
    packageGeneration: requireInt(raw.package_generation, "package_generation"),
    activationEpoch: requireInt(raw.activation_epoch, "activation_epoch"),
    hostSessionId: requireString(raw.host_session_id, "host_session_id"),
    surface: parsePluginSurface(raw.surface),
  };
}

/** Human-readable permission capability labels for PermissionDialog. */
export const PERMISSION_LABELS: Record<string, string> = {
  "tasks:read": "Read your tasks, projects, and tags",
  "tasks:write": "Create and modify tasks",
  "projects:read": "Read your projects",
  "projects:write": "Create and modify projects",
  "tags:read": "Read your tags",
  "tags:write": "Create and modify tags",
  "events:subscribe": "Subscribe to workspace events",
  settings: "Read and write plugin settings",
  storage: "Use isolated plugin storage",
  commands: "Register keyboard commands",
  "ui:view": "Add views to navigation",
  "ui:panel": "Add sidebar panels",
  "ui:status": "Add items to the status bar",
  "services:provide": "Provide services to other plugins",
  "services:consume": "Call other plugin services",
  http: "Make bounded network requests",
  logging: "Write diagnostic logs",
};

/** Map legacy-style permission strings used in fixtures to modern capabilities. */
export function normalizePermissionId(id: string): string {
  const map: Record<string, string> = {
    "task:read": "tasks:read",
    "task:write": "tasks:write",
    "project:read": "projects:read",
    "project:write": "projects:write",
  };
  return map[id] ?? id;
}

export function permissionDescription(capability: string): string {
  return PERMISSION_LABELS[normalizePermissionId(capability)] ?? capability;
}

/** Concise disclosure for the three scoped permission forms. Unscoped rows stay unchanged. */
export function permissionScopeDescription(permission: PluginPermission): string | null {
  const { scope } = permission;
  if ("event_kinds" in scope) {
    return `Event kinds: ${scope.event_kinds.join(", ")}`;
  }
  if ("services" in scope) {
    return `Services: ${scope.services
      .map((service) => `${service.plugin_id}/${service.service_id}`)
      .join(", ")}`;
  }
  if ("origins" in scope && "methods" in scope) {
    return `HTTP origins: ${scope.origins.join(", ")}; methods: ${scope.methods.join(", ")}`;
  }
  return null;
}

function jsonValueEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValueEqual(value, right[index]))
    );
  }
  if (!isObject(left) || !isObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && jsonValueEqual(left[key], right[key]))
  );
}

/** Exact requested scopes, not capability names alone, must all be granted before enabling. */
export function arePermissionsFullyGranted(
  requested: PluginPermission[],
  granted: PluginPermission[],
): boolean {
  return requested.every((permission) =>
    granted.some(
      (grant) =>
        grant.capability === permission.capability && jsonValueEqual(grant.scope, permission.scope),
    ),
  );
}

/** Stale-authority HTTP statuses that require dropping contributions and refreshing. */
export function isStaleAuthorityError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  const code = (error as { code?: unknown }).code;
  if (status === 409) return true;
  if (typeof code === "string") {
    const lower = code.toLowerCase();
    if (
      lower.includes("stale") ||
      lower.includes("authority") ||
      lower.includes("generation") ||
      lower.includes("session") ||
      lower.includes("fence")
    ) {
      return true;
    }
  }
  return false;
}
