/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** When "true", the frontend uses the Hono API server instead of in-process WASM. */
  readonly VITE_USE_BACKEND?: string;
  /** Override the API base URL (e.g. "http://localhost:4822/api"). */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.sql?raw" {
  const content: string;
  export default content;
}

declare module "*.json?raw" {
  const content: string;
  export default content;
}
