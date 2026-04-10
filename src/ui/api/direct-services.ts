import type { WebAppServices } from "../../bootstrap-web.js";

export type WebServices = WebAppServices;

let services: WebServices | null = null;
let pending: Promise<WebServices> | null = null;

export async function getServices(): Promise<WebServices> {
  if (services) return services;
  if (pending) return pending;

  pending = (async () => {
    try {
      const { bootstrapWeb } = await import("../../bootstrap-web.js");
      services = await bootstrapWeb();
      return services;
    } finally {
      pending = null;
    }
  })();

  return pending;
}
