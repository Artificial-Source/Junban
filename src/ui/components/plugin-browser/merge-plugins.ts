import type { PluginInfo, StorePluginInfo } from "../../api/index.js";
import type { BrowserPlugin } from "./plugin-browser-types.js";

// ── Data merging ─────────────────────────────────────

export function mergePlugins(installed: PluginInfo[], store: StorePluginInfo[]): BrowserPlugin[] {
  const installedMap = new Map(installed.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const result: BrowserPlugin[] = [];

  // Store plugins are the base
  for (const sp of store) {
    seen.add(sp.id);
    const ip = installedMap.get(sp.id);
    result.push({
      id: sp.id,
      name: sp.name,
      description: sp.description,
      author: sp.author,
      version: sp.version,
      icon: sp.icon ?? ip?.icon,
      repository: sp.repository,
      downloadUrl: sp.downloadUrl,
      tags: sp.tags,
      downloads: sp.downloads,
      longDescription: sp.longDescription,
      installed: !!ip,
      enabled: ip?.enabled ?? false,
      builtin: ip?.builtin ?? false,
      permissions: ip?.permissions ?? sp.permissions ?? [],
      settings: ip?.settings ?? [],
    });
  }

  // Installed-only plugins (not in store) appended
  for (const ip of installed) {
    if (!seen.has(ip.id)) {
      result.push({
        id: ip.id,
        name: ip.name,
        description: ip.description,
        author: ip.author,
        version: ip.version,
        icon: ip.icon,
        tags: [],
        installed: true,
        enabled: ip.enabled,
        builtin: ip.builtin,
        permissions: ip.permissions,
        settings: ip.settings,
      });
    }
  }

  return result;
}
