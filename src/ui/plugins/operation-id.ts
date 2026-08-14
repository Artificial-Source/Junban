/**
 * Operation identity helpers for plugin mutations.
 * One UUID per logical mutation; retain across same-action retries.
 */

import { generateOperationId } from "../api/client";

export function createPluginOperationId(): string {
  return generateOperationId();
}

export class RetainedPluginOperationId {
  #id: string | null;

  constructor(existing?: string) {
    this.#id = existing ?? null;
  }

  get id(): string {
    if (this.#id === null) {
      this.#id = createPluginOperationId();
    }
    return this.#id;
  }

  get assigned(): boolean {
    return this.#id !== null;
  }

  reset(): void {
    this.#id = null;
  }
}
