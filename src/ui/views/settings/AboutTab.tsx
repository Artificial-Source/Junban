import { useState, useEffect } from "react";
import { ExternalLink, Bug, MessageSquarePlus } from "lucide-react";
import { isTauri } from "../../../utils/tauri.js";
import { APP_VERSION } from "../../../config/defaults.js";
import { api } from "../../api/index.js";

interface Credit {
  name: string;
  url: string;
  description: string;
  license: string;
}

const CREDITS: { category: string; items: Credit[] }[] = [
  {
    category: "AI & Machine Learning",
    items: [
      {
        name: "OpenAI Node SDK",
        url: "https://github.com/openai/openai-node",
        description:
          "OpenAI-compatible API client powering chat with OpenAI, OpenRouter, Ollama, and LM Studio",
        license: "Apache-2.0",
      },
      {
        name: "Anthropic SDK",
        url: "https://github.com/anthropics/anthropic-sdk-typescript",
        description: "Official Anthropic API client for Claude integration",
        license: "MIT",
      },
      {
        name: "Transformers.js",
        url: "https://github.com/huggingface/transformers.js",
        description:
          "Hugging Face's ML library enabling local Whisper speech-to-text in the browser",
        license: "Apache-2.0",
      },
      {
        name: "Kokoro.js",
        url: "https://github.com/hexgrad/kokoro",
        description: "Local text-to-speech with 21 natural voices, runs entirely in the browser",
        license: "Apache-2.0",
      },
      {
        name: "VAD Web",
        url: "https://github.com/ricky0123/vad",
        description: "Voice Activity Detection for hands-free voice input",
        license: "ISC",
      },
    ],
  },
  {
    category: "Frontend",
    items: [
      { name: "React", url: "https://react.dev", description: "UI framework", license: "MIT" },
      {
        name: "Tailwind CSS",
        url: "https://tailwindcss.com",
        description: "Utility-first CSS framework for the entire design system",
        license: "MIT",
      },
      {
        name: "Lucide",
        url: "https://lucide.dev",
        description: "Beautiful open-source icons used throughout the app",
        license: "ISC",
      },
      {
        name: "dnd kit",
        url: "https://dndkit.com",
        description: "Drag-and-drop toolkit for task reordering",
        license: "MIT",
      },
      {
        name: "React Markdown",
        url: "https://github.com/remarkjs/react-markdown",
        description: "Markdown rendering for AI chat responses",
        license: "MIT",
      },
    ],
  },
  {
    category: "Database & Storage",
    items: [
      {
        name: "Drizzle ORM",
        url: "https://orm.drizzle.team",
        description: "Type-safe, lightweight ORM for SQLite",
        license: "Apache-2.0",
      },
      {
        name: "better-sqlite3",
        url: "https://github.com/WiseLibs/better-sqlite3",
        description: "Fast, synchronous SQLite3 driver for Node.js",
        license: "MIT",
      },
      {
        name: "sql.js",
        url: "https://github.com/sql-js/sql.js",
        description: "SQLite compiled to WebAssembly for in-browser database",
        license: "MIT",
      },
    ],
  },
  {
    category: "Desktop & Platform",
    items: [
      {
        name: "Tauri",
        url: "https://tauri.app",
        description: "Cross-platform desktop app framework — tiny binaries, native performance",
        license: "Apache-2.0/MIT",
      },
      {
        name: "Vite",
        url: "https://vite.dev",
        description: "Lightning-fast build tool and dev server",
        license: "MIT",
      },
    ],
  },
  {
    category: "Parsing & Utilities",
    items: [
      {
        name: "chrono-node",
        url: "https://github.com/wanasit/chrono",
        description: "Natural language date/time parsing for task input",
        license: "MIT",
      },
      {
        name: "Zod",
        url: "https://zod.dev",
        description: "TypeScript-first schema validation",
        license: "MIT",
      },
      {
        name: "Commander.js",
        url: "https://github.com/tj/commander.js",
        description: "CLI framework for the companion command-line tool",
        license: "MIT",
      },
      {
        name: "yaml",
        url: "https://github.com/eemeli/yaml",
        description: "YAML parser for Markdown storage backend",
        license: "ISC",
      },
    ],
  },
  {
    category: "Testing",
    items: [
      {
        name: "Vitest",
        url: "https://vitest.dev",
        description: "Fast, Vite-native test runner",
        license: "MIT",
      },
      {
        name: "Testing Library",
        url: "https://testing-library.com",
        description: "User-centric testing utilities for React components",
        license: "MIT",
      },
    ],
  },
];

function detectOS(): string {
  const ua = navigator.userAgent;
  if (ua.includes("Win")) return "Windows";
  if (ua.includes("Mac")) return "macOS";
  if (ua.includes("Linux")) return "Linux";
  if (ua.includes("Android")) return "Android";
  if (ua.includes("iPhone") || ua.includes("iPad")) return "iOS";
  return "Unknown";
}

export function AboutTab() {
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "checking" | "available" | "up-to-date" | "error"
  >("idle");
  const [updateVersion, setUpdateVersion] = useState("");
  const isTauriApp = isTauri();

  // System info state
  const [systemInfo, setSystemInfo] = useState<{
    storage: string;
    tasks: number;
    plugins: number;
    os: string;
    runtime: string;
  } | null>(null);

  useEffect(() => {
    const os = detectOS();
    const runtime = isTauri() ? "Tauri (Desktop)" : "Browser";

    Promise.all([
      api.getStorageInfo().catch(() => ({ mode: "unknown" })),
      api
        .exportAllData()
        .then((d) => d.tasks.length)
        .catch(() => 0),
      api
        .listPlugins()
        .then((p) => p.length)
        .catch(() => 0),
    ]).then(([storageInfo, taskCount, pluginCount]) => {
      setSystemInfo({
        storage: (storageInfo as any).mode === "markdown" ? "Markdown" : "SQLite",
        tasks: taskCount,
        plugins: pluginCount,
        os,
        runtime,
      });
    });
  }, []);

  const handleCheckUpdate = async () => {
    setUpdateStatus("checking");
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        setUpdateStatus("available");
        setUpdateVersion(update.version);
      } else {
        setUpdateStatus("up-to-date");
      }
    } catch {
      setUpdateStatus("error");
    }
  };

  const handleInstallUpdate = async () => {
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        await update.downloadAndInstall();
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      }
    } catch {
      setUpdateStatus("error");
    }
  };

  return (
    <section className="space-y-8">
      {/* App info */}
      <div>
        <div className="flex items-center gap-3">
          <img src="/images/logo-192.png" alt="Saydo logo" className="w-12 h-12" />
          <div>
            <p className="text-sm font-semibold text-on-surface">
              ASF Saydo{" "}
              <span className="font-mono text-on-surface-muted font-normal">v{APP_VERSION}</span>
            </p>
            <p className="text-xs text-on-surface-muted">
              Open-source, AI-native task manager with an Obsidian-style plugin system.
            </p>
          </div>
        </div>
        {isTauriApp && (
          <div className="mt-3">
            <button
              onClick={handleCheckUpdate}
              disabled={updateStatus === "checking"}
              className="px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-surface-secondary disabled:opacity-50"
            >
              {updateStatus === "checking" ? "Checking..." : "Check for Updates"}
            </button>
            {updateStatus === "available" && (
              <div className="mt-2">
                <p className="text-sm text-success">Update available: v{updateVersion}</p>
                <button
                  onClick={handleInstallUpdate}
                  className="mt-1 px-3 py-1.5 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover"
                >
                  Install and Restart
                </button>
              </div>
            )}
            {updateStatus === "up-to-date" && (
              <p className="mt-2 text-sm text-on-surface-muted">You're up to date!</p>
            )}
            {updateStatus === "error" && (
              <p className="mt-2 text-sm text-error">Update check failed.</p>
            )}
          </div>
        )}
      </div>

      {/* System Info */}
      {systemInfo && (
        <div>
          <h3 className="text-sm font-semibold text-on-surface mb-2">System Info</h3>
          <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 max-w-sm text-xs">
            <span className="text-on-surface-muted">Platform</span>
            <span className="text-on-surface-secondary">{systemInfo.os}</span>
            <span className="text-on-surface-muted">Runtime</span>
            <span className="text-on-surface-secondary">{systemInfo.runtime}</span>
            <span className="text-on-surface-muted">Storage</span>
            <span className="text-on-surface-secondary">{systemInfo.storage}</span>
            <span className="text-on-surface-muted">Tasks</span>
            <span className="text-on-surface-secondary">{systemInfo.tasks}</span>
            <span className="text-on-surface-muted">Plugins</span>
            <span className="text-on-surface-secondary">{systemInfo.plugins}</span>
          </div>
        </div>
      )}

      {/* Feedback Links */}
      <div>
        <h3 className="text-sm font-semibold text-on-surface mb-2">Feedback</h3>
        <div className="flex gap-3">
          <a
            href="https://github.com/ASF-GROUP/Saydo/issues/new?labels=bug"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-surface-secondary transition-colors text-on-surface-secondary"
          >
            <Bug size={14} />
            Report a Bug
          </a>
          <a
            href="https://github.com/ASF-GROUP/Saydo/issues/new?labels=enhancement"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-surface-secondary transition-colors text-on-surface-secondary"
          >
            <MessageSquarePlus size={14} />
            Request a Feature
          </a>
        </div>
      </div>

      {/* Credits */}
      <div>
        <h3 className="text-sm font-semibold text-on-surface mb-1">Open Source Credits</h3>
        <p className="text-xs text-on-surface-muted mb-4">
          Saydo is built on the shoulders of these incredible open-source projects. Huge thanks to
          every contributor.
        </p>

        <div className="space-y-5">
          {CREDITS.map((group) => (
            <div key={group.category}>
              <h4 className="text-xs font-semibold text-on-surface-secondary uppercase tracking-wider mb-2">
                {group.category}
              </h4>
              <div className="space-y-1.5">
                {group.items.map((item) => (
                  <a
                    key={item.name}
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-start gap-2 p-2 -mx-2 rounded-lg hover:bg-surface-secondary transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium text-on-surface group-hover:text-accent transition-colors">
                        {item.name}
                      </span>
                      <span className="ml-1.5 text-[10px] text-on-surface-muted font-mono">
                        {item.license}
                      </span>
                      <p className="text-xs text-on-surface-muted leading-snug">
                        {item.description}
                      </p>
                    </div>
                    <ExternalLink
                      size={12}
                      className="mt-1 shrink-0 text-on-surface-muted opacity-0 group-hover:opacity-100 transition-opacity"
                    />
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="pt-2 border-t border-border">
        <p className="text-xs text-on-surface-muted">
          Built by the{" "}
          <a
            href="https://github.com/ASF-GROUP"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            AI Strategic Forum
          </a>{" "}
          community. Licensed under MIT.
        </p>
      </div>
    </section>
  );
}
