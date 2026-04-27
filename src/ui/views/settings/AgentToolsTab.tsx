import { useEffect, useState } from "react";
import { Check, Copy, Download, ExternalLink, Terminal } from "lucide-react";
import { APP_VERSION } from "../../../config/defaults.js";
import { isTauri } from "../../../utils/tauri.js";

const RELEASES_URL = "https://github.com/Artificial-Source/Junban/releases/latest";
const MCP_DOCS_URL =
  "https://github.com/Artificial-Source/Junban/blob/main/docs/how-to/connect-claude-desktop.md";
const CLI_DOCS_URL = "https://github.com/Artificial-Source/Junban/blob/main/docs/how-to/use-cli.md";

const CLAUDE_CONFIG = `{
  "mcpServers": {
    "junban": {
      "command": "junban-mcp",
      "args": []
    }
  }
}`;

const SOURCE_CHECKOUT_CONFIG = `{
  "mcpServers": {
    "junban": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/junban", "mcp"]
    }
  }
}`;

const AGENT_SKILL = `# Junban Agent Skill

Use Junban when the user wants to manage tasks, plan a day, review workload, or capture reminders.

## Available local tools

- CLI command: junban
- MCP server command: junban-mcp

## Preferred behavior

1. Use MCP first when your agent supports it.
2. Use the CLI for simple terminal workflows.
3. Use junban tools and junban tool <name> --args '{...}' when MCP is unavailable but terminal control is available.
4. Keep task data local to the user's machine.

## Useful CLI examples

\`\`\`bash
junban add "submit invoice tomorrow p1 #finance"
junban list --today --json
junban done <task-id>
junban edit <task-id> --due "next friday"
junban tools --json
junban tool create_task --args '{"title":"Review roadmap","priority":2}'
\`\`\`

## MCP setup

Add this server to your MCP client:

\`\`\`json
${CLAUDE_CONFIG}
\`\`\`
`;

type DownloadTarget = "claude" | "skill" | "source";

async function downloadTextFile(filename: string, text: string): Promise<boolean> {
  if (isTauri()) {
    const [{ save }, { writeTextFile }] = await Promise.all([
      import("@tauri-apps/plugin-dialog"),
      import("@tauri-apps/plugin-fs"),
    ]);
    const path = await save({
      title: "Save Junban agent setup file",
      defaultPath: filename,
      filters: [
        {
          name: filename.endsWith(".json") ? "JSON" : "Markdown",
          extensions: [filename.endsWith(".json") ? "json" : "md"],
        },
      ],
    });

    if (!path) return false;
    await writeTextFile(path, text);
    return true;
  }

  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

function getDownload(target: DownloadTarget): { filename: string; text: string } {
  switch (target) {
    case "claude":
      return { filename: "junban-claude-mcp-config.json", text: CLAUDE_CONFIG };
    case "source":
      return { filename: "junban-source-checkout-mcp-config.json", text: SOURCE_CHECKOUT_CONFIG };
    case "skill":
      return { filename: "junban-agent-skill.md", text: AGENT_SKILL };
  }
}

export function AgentToolsTab() {
  const [copied, setCopied] = useState<DownloadTarget | null>(null);
  const [downloaded, setDownloaded] = useState<DownloadTarget | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    if (!copied && !downloaded) return;
    const timeout = window.setTimeout(() => {
      setCopied(null);
      setDownloaded(null);
    }, 1600);
    return () => window.clearTimeout(timeout);
  }, [copied, downloaded]);

  const handleCopy = async (target: DownloadTarget) => {
    const item = getDownload(target);
    try {
      await navigator.clipboard.writeText(item.text);
      setCopied(target);
    } catch {
      setCopied(null);
    }
  };

  const handleDownload = async (target: DownloadTarget) => {
    const item = getDownload(target);
    try {
      const saved = await downloadTextFile(item.filename, item.text);
      setDownloadError(null);
      setDownloaded(saved ? target : null);
    } catch (err) {
      setDownloaded(null);
      const message = err instanceof Error ? err.message : "Unknown error";
      setDownloadError(`Could not save file. ${message}`);
    }
  };

  return (
    <section className="space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Terminal className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-on-surface">Agent Tools</h3>
            <p className="text-xs text-on-surface-muted">
              Connect Junban to terminals, Claude Desktop, and other AI agents.
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-surface-secondary p-4">
        <h4 className="text-sm font-semibold text-on-surface">Installed commands</h4>
        <p className="mt-1 text-xs text-on-surface-muted">
          Junban publishes two local commands after installation and build.
        </p>
        <div className="mt-3 space-y-2 text-xs">
          <code className="block rounded-lg border border-border bg-surface px-3 py-2 text-on-surface-secondary">
            junban
          </code>
          <code className="block rounded-lg border border-border bg-surface px-3 py-2 text-on-surface-secondary">
            junban-mcp
          </code>
        </div>
        <p className="mt-3 text-xs text-on-surface-muted">
          App version: <span className="font-mono">{APP_VERSION}</span>
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <SetupCard
          title="Claude MCP config"
          description="Use this when Junban is installed as a normal command."
          target="claude"
          copied={copied === "claude"}
          downloaded={downloaded === "claude"}
          onCopy={handleCopy}
          onDownload={handleDownload}
        />
        <SetupCard
          title="Agent skill"
          description="Give this to another AI agent so it knows how to use Junban."
          target="skill"
          copied={copied === "skill"}
          downloaded={downloaded === "skill"}
          onCopy={handleCopy}
          onDownload={handleDownload}
        />
        <SetupCard
          title="Source checkout config"
          description="Use this while running Junban from a cloned project folder."
          target="source"
          copied={copied === "source"}
          downloaded={downloaded === "source"}
          onCopy={handleCopy}
          onDownload={handleDownload}
        />
      </div>

      {downloadError && <p className="text-xs text-danger">{downloadError}</p>}

      <div className="flex flex-wrap gap-3 text-xs">
        <a
          href={RELEASES_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-accent hover:underline"
        >
          Download Junban
          <ExternalLink className="h-3 w-3" />
        </a>
        <a
          href={MCP_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-accent hover:underline"
        >
          MCP setup guide
          <ExternalLink className="h-3 w-3" />
        </a>
        <a
          href={CLI_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-accent hover:underline"
        >
          CLI guide
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </section>
  );
}

interface SetupCardProps {
  title: string;
  description: string;
  target: DownloadTarget;
  copied: boolean;
  downloaded: boolean;
  onCopy(target: DownloadTarget): void;
  onDownload(target: DownloadTarget): void;
}

function SetupCard({
  title,
  description,
  target,
  copied,
  downloaded,
  onCopy,
  onDownload,
}: SetupCardProps) {
  return (
    <div className="rounded-xl border border-border p-4">
      <h4 className="text-sm font-semibold text-on-surface">{title}</h4>
      <p className="mt-1 min-h-8 text-xs text-on-surface-muted">{description}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onDownload(target)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-on-surface-secondary transition-colors hover:bg-surface-secondary"
        >
          {downloaded ? <Check className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
          {downloaded ? "Saved" : "Download"}
        </button>
        <button
          type="button"
          onClick={() => onCopy(target)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-on-surface-secondary transition-colors hover:bg-surface-secondary"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
