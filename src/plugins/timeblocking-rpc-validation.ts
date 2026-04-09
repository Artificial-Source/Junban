export type RpcValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateTimeblockingRpcPayload(
  payload: unknown,
): RpcValidationResult<{ method: string; args: unknown[] }> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, error: "body must be an object" };
  }

  const { method, args } = payload as { method?: unknown; args?: unknown };

  if (typeof method !== "string" || !method) {
    return { ok: false, error: "method must be a non-empty string" };
  }
  if (!Array.isArray(args)) {
    return { ok: false, error: "args must be an array" };
  }

  return { ok: true, value: { method, args } };
}

export function expectRpcString(
  args: unknown[],
  index: number,
  name: string,
): RpcValidationResult<string> {
  if (typeof args[index] !== "string" || !args[index]) {
    return { ok: false, error: `${name} (args[${index}]) must be a non-empty string` };
  }

  return { ok: true, value: args[index] as string };
}

export function expectRpcOptionalString(
  args: unknown[],
  index: number,
  name: string,
): RpcValidationResult<string | undefined> {
  if (args[index] === undefined || args[index] === null) {
    return { ok: true, value: undefined };
  }

  if (typeof args[index] !== "string") {
    return { ok: false, error: `${name} (args[${index}]) must be a string when provided` };
  }

  return { ok: true, value: args[index] };
}

export function expectRpcObject(
  args: unknown[],
  index: number,
  name: string,
): RpcValidationResult<Record<string, unknown>> {
  if (typeof args[index] !== "object" || args[index] === null || Array.isArray(args[index])) {
    return { ok: false, error: `${name} (args[${index}]) must be an object` };
  }

  return { ok: true, value: args[index] as Record<string, unknown> };
}

export function expectRpcStringArray(
  args: unknown[],
  index: number,
  name: string,
): RpcValidationResult<string[]> {
  if (!Array.isArray(args[index]) || !(args[index] as unknown[]).every((v) => typeof v === "string")) {
    return { ok: false, error: `${name} (args[${index}]) must be an array of strings` };
  }

  return { ok: true, value: args[index] as string[] };
}
