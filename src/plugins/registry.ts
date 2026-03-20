import fs from "node:fs";
import { z } from "zod";

const RegistryEntry = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  author: z.string(),
  version: z.string(),
  repository: z.string(),
  downloadUrl: z.string().url().optional(),
  tags: z.array(z.string()),
  minSaydoVersion: z.string(),
});

const _RegistrySchema = z.object({
  version: z.number(),
  description: z.string().optional(),
  lastUpdated: z.string().optional(),
  plugins: z.array(RegistryEntry),
});

export type RegistryEntry = z.infer<typeof RegistryEntry>;
export type Registry = z.infer<typeof _RegistrySchema>;

/** TTL for the in-memory remote registry cache (5 minutes). */
export const REGISTRY_CACHE_TTL_MS = 5 * 60 * 1000;

interface RegistryCache {
  data: RegistryEntry[];
  fetchedAt: number;
}

/**
 * Plugin registry client — fetches and parses the community plugin directory.
 */
export class PluginRegistry {
  private remoteCache: Map<string, RegistryCache> = new Map();

  constructor(private registryPath: string) {}

  /** Load the registry from a local JSON file. */
  async loadLocal(): Promise<RegistryEntry[]> {
    try {
      const data = fs.readFileSync(this.registryPath, "utf-8");
      const parsed = _RegistrySchema.safeParse(JSON.parse(data));
      if (parsed.success) {
        return parsed.data.plugins;
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * Fetch the registry from a remote URL.
   * Results are cached in memory for {@link REGISTRY_CACHE_TTL_MS} (default 5 min).
   * Pass `forceRefresh: true` to bypass the cache.
   */
  async fetchRemote(
    url: string,
    opts?: { forceRefresh?: boolean },
  ): Promise<RegistryEntry[]> {
    // Return cached data if still fresh
    if (!opts?.forceRefresh) {
      const cached = this.remoteCache.get(url);
      if (cached && Date.now() - cached.fetchedAt < REGISTRY_CACHE_TTL_MS) {
        return cached.data;
      }
    }

    try {
      const res = await fetch(url);
      if (!res.ok) return [];
      const json = await res.json();
      const parsed = _RegistrySchema.safeParse(json);
      if (parsed.success) {
        this.remoteCache.set(url, {
          data: parsed.data.plugins,
          fetchedAt: Date.now(),
        });
        return parsed.data.plugins;
      }
      return [];
    } catch {
      return [];
    }
  }

  /** Search plugins by keyword. */
  search(plugins: RegistryEntry[], query: string): RegistryEntry[] {
    const q = query.toLowerCase();
    return plugins.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.tags.some((t) => t.includes(q)),
    );
  }
}
