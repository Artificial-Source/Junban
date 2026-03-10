import type { ViteDevServer } from "vite";
import type { IncomingMessage } from "node:http";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GetServices = () => Promise<any>;

export type RouteRegistrar = (server: ViteDevServer, getServices: GetServices) => void;

export function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk));
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON in request body"));
      }
    });
  });
}
