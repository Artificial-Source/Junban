import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStoredToken, storeToken } from "../api/client";
import { invokeCommand } from "./transport";

const TOKEN = "plugin-transport-test-token";
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const headers = init?.headers;
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers as Record<string, string>;
}

describe("plugin command transport", () => {
  beforeEach(() => {
    clearStoredToken();
    storeToken(TOKEN);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearStoredToken();
  });

  it("sends the exact contribution fence with the command invocation", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: "completed",
            terminal_kind: "readonly",
            revision: null,
            rejection: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await invokeCommand(
      "demo plugin",
      "run/now",
      {
        packageGeneration: 9,
        activationEpoch: 3,
        hostSessionId: "22222222-2222-4222-8222-222222222222",
      },
      [],
      { operationId: OPERATION_ID },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/plugins/demo%20plugin/commands/run%2Fnow");
    expect(init.method).toBe("POST");
    expect(headersOf(init)).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      "Idempotency-Key": OPERATION_ID,
    });
    expect(JSON.parse(String(init.body))).toEqual({
      package_generation: 9,
      activation_epoch: 3,
      host_session_id: "22222222-2222-4222-8222-222222222222",
      values: [],
    });
  });
});
