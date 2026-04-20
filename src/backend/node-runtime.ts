import { createLogger } from "../utils/logger.js";
import type { AppServices } from "./kernel.js";
import { createNodeBackendServices, type NodeBackendFactoryOptions } from "./node-factory.js";

const logger = createLogger("backend-runtime");

export class NodeBackendRuntime {
  private initializing: Promise<void> | null = null;
  private disposing: Promise<void> | null = null;
  private pluginLoadComplete = false;

  constructor(readonly services: AppServices) {}

  async initialize(): Promise<void> {
    if (this.pluginLoadComplete) {
      return;
    }

    if (this.initializing) {
      await this.initializing;
      return;
    }

    this.initializing = (async () => {
      try {
        await this.services.pluginLoader.loadAll();
        const loaded = this.services.pluginLoader.getAll().filter((plugin) => plugin.enabled);
        this.pluginLoadComplete = true;
        logger.info("Plugins initialized", { loaded: loaded.length });
      } catch (err) {
        this.pluginLoadComplete = false;
        logger.error(`Plugin initialization failed: ${err instanceof Error ? err.message : err}`);
        throw err;
      } finally {
        this.initializing = null;
      }
    })();

    await this.initializing;
  }

  async dispose(): Promise<void> {
    if (this.initializing) {
      try {
        await this.initializing;
      } catch (err) {
        logger.error(
          `Plugin initialization failed during dispose: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    const hasEnabledPlugins = this.services.pluginLoader.getAll().some((plugin) => plugin.enabled);
    if (!this.pluginLoadComplete && !hasEnabledPlugins) {
      return;
    }

    if (this.disposing) {
      await this.disposing;
      return;
    }

    this.disposing = (async () => {
      try {
        const shouldUnload = this.services.pluginLoader.getAll().some((plugin) => plugin.enabled);
        if (shouldUnload) {
          await this.services.pluginLoader.unloadAll();
          logger.info("Plugins unloaded");
        }
      } catch (err) {
        logger.error(`Plugin unload error: ${err instanceof Error ? err.message : err}`);
      } finally {
        this.pluginLoadComplete = false;
        this.disposing = null;
      }
    })();

    await this.disposing;
  }
}

export function createNodeBackendRuntime(
  options: NodeBackendFactoryOptions = {},
): NodeBackendRuntime {
  return new NodeBackendRuntime(createNodeBackendServices(options));
}
