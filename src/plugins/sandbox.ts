import fs from "node:fs";
import path from "node:path";
import * as vm from "node:vm";

/**
 * Plugin sandbox for community plugins.
 *
 * Community plugin code executes in an isolated `vm` context and cannot use
 * unrestricted host imports.
 */

export interface SandboxOptions {
  pluginId: string;
  pluginDir: string;
  permissions: string[];
}

export interface PluginSandbox {
  execute(entryFile: string): Promise<Record<string, unknown>>;
  destroy(): void;
}

const ALLOWED_EXTENSIONS = [".js", ".mjs", ".cjs"];

function isIdentifierChar(ch: string | undefined): boolean {
  return Boolean(ch && /[A-Za-z0-9_$]/.test(ch));
}

function skipTrivia(source: string, start: number): number {
  let i = start;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length) {
        if (source[i] === "*" && source[i + 1] === "/") {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    break;
  }

  return i;
}

function assertNoDisallowedImports(source: string, pluginId: string): void {
  const failImport = (kind: "dynamic" | "statement") => {
    if (kind === "dynamic") {
      throw new Error(
        `Plugin "${pluginId}" cannot use dynamic import() in community sandbox`,
      );
    }
    throw new Error(
      `Plugin "${pluginId}" cannot use ESM import statements in community sandbox. Use relative require() for local files.`,
    );
  };

  const failImportMeta = () => {
    throw new Error(
      `Plugin "${pluginId}" cannot use import.meta in community sandbox. Use relative require() and manifest metadata instead.`,
    );
  };

  const scanSingleOrDoubleQuoted = (start: number, quote: "'" | '"'): number => {
    let i = start;
    while (i < source.length) {
      const ch = source[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) {
        return i + 1;
      }
      i++;
    }
    return i;
  };

  const checkImportToken = (afterWordIndex: number) => {
    const next = skipTrivia(source, afterWordIndex);
    const nextChar = source[next];
    if (nextChar === "(") {
      failImport("dynamic");
      return;
    }
    if (nextChar === ".") {
      const afterDot = skipTrivia(source, next + 1);
      if (source.slice(afterDot, afterDot + 4) === "meta") {
        failImportMeta();
        return;
      }
      failImport("statement");
      return;
    }
    if (nextChar !== ".") {
      failImport("statement");
    }
  };

  const scanCodeUntil = (start: number, endChar?: string): number => {
    let i = start;
    while (i < source.length) {
      const ch = source[i];
      const next = source[i + 1];

      if (endChar && ch === endChar) {
        return i + 1;
      }

      if (ch === "/" && next === "/") {
        i += 2;
        while (i < source.length && source[i] !== "\n") i++;
        continue;
      }

      if (ch === "/" && next === "*") {
        i += 2;
        while (i < source.length) {
          if (source[i] === "*" && source[i + 1] === "/") {
            i += 2;
            break;
          }
          i++;
        }
        continue;
      }

      if (ch === "'" || ch === '"') {
        i = scanSingleOrDoubleQuoted(i + 1, ch);
        continue;
      }

      if (ch === "`") {
        i = scanTemplateLiteral(i + 1);
        continue;
      }

      if (isIdentifierChar(ch) && !isIdentifierChar(source[i - 1])) {
        let end = i + 1;
        while (isIdentifierChar(source[end])) end++;
        const word = source.slice(i, end);
        if (word === "import") {
          checkImportToken(end);
        }
        i = end;
        continue;
      }

      i++;
    }

    return i;
  };

  const scanTemplateLiteral = (start: number): number => {
    let i = start;
    while (i < source.length) {
      const ch = source[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        return i + 1;
      }
      if (ch === "$" && source[i + 1] === "{") {
        i = scanCodeUntil(i + 2, "}");
        continue;
      }
      i++;
    }
    return i;
  };

  scanCodeUntil(0);
}

function transformPluginSource(source: string, pluginId: string): string {
  assertNoDisallowedImports(source, pluginId);

  let transformed = source.replace(
    /^\s*export\s*\{[^}]+\};?\s*$/gm,
    "",
  );

  transformed = transformed.replace(
    /\bexport\s+default\b/,
    "module.exports.default =",
  );

  transformed = transformed.replace(
    /^\s*export\s+(const|let|var|function|class)\s+/gm,
    "$1 ",
  );

  return transformed;
}

export function createSandbox(options: SandboxOptions): PluginSandbox {
  const pluginRoot = path.resolve(options.pluginDir);
  const pluginRootRealPath = fs.realpathSync.native(pluginRoot);
  const moduleCache = new Map<string, Record<string, unknown>>();
  const activeTimeouts = new Set<ReturnType<typeof setTimeout>>();
  const activeIntervals = new Set<ReturnType<typeof setInterval>>();

  const sandboxSetTimeout: typeof setTimeout = ((callback: unknown, delay?: number, ...args: unknown[]) => {
    const timeout = setTimeout(() => {
      activeTimeouts.delete(timeout);
      if (typeof callback === "function") {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
        (callback as Function)(...args);
      }
    }, delay);
    activeTimeouts.add(timeout);
    return timeout;
  }) as typeof setTimeout;

  const sandboxClearTimeout: typeof clearTimeout = ((timeout: unknown) => {
    activeTimeouts.delete(timeout as ReturnType<typeof setTimeout>);
    clearTimeout(timeout as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;

  const sandboxSetInterval: typeof setInterval = ((callback: unknown, delay?: number, ...args: unknown[]) => {
    const interval = setInterval(() => {
      if (typeof callback === "function") {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
        (callback as Function)(...args);
      }
    }, delay);
    activeIntervals.add(interval);
    return interval;
  }) as typeof setInterval;

  const sandboxClearInterval: typeof clearInterval = ((interval: unknown) => {
    activeIntervals.delete(interval as ReturnType<typeof setInterval>);
    clearInterval(interval as ReturnType<typeof setInterval>);
  }) as typeof clearInterval;

  const sandboxConsole = Object.freeze({
    log: (...args: unknown[]) => console.log(...args),
    info: (...args: unknown[]) => console.info(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => console.error(...args),
    debug: (...args: unknown[]) => console.debug(...args),
  });

  const context = vm.createContext(
    {
      console: sandboxConsole,
      setTimeout: sandboxSetTimeout,
      clearTimeout: sandboxClearTimeout,
      setInterval: sandboxSetInterval,
      clearInterval: sandboxClearInterval,
      queueMicrotask,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      AbortController,
      AbortSignal,
      structuredClone,
    },
    {
      codeGeneration: {
        strings: false,
        wasm: false,
      },
      name: `plugin:${options.pluginId}`,
    },
  );

  const assertInsidePluginRoot = (absolutePath: string): string => {
    const absoluteRealPath = fs.realpathSync.native(absolutePath);
    const relative = path.relative(pluginRootRealPath, absoluteRealPath);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `Plugin "${options.pluginId}" attempted to import outside its directory: ${absoluteRealPath}`,
      );
    }
    return absoluteRealPath;
  };

  const resolveFile = (baseFile: string, specifier: string): string => {
    if (specifier.startsWith("node:")) {
      throw new Error(
        `Plugin "${options.pluginId}" cannot import Node built-in modules (${specifier})`,
      );
    }

    if (specifier.startsWith("/") || specifier.startsWith("file://")) {
      throw new Error(
        `Plugin "${options.pluginId}" cannot use absolute imports (${specifier})`,
      );
    }

    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      throw new Error(
        `Plugin "${options.pluginId}" cannot import external modules (${specifier}). Community plugins may only import local plugin files.`,
      );
    }

    const resolvedPath = path.resolve(path.dirname(baseFile), specifier);

    if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
      return assertInsidePluginRoot(resolvedPath);
    }

    for (const ext of ALLOWED_EXTENSIONS) {
      const withExtension = `${resolvedPath}${ext}`;
      if (fs.existsSync(withExtension) && fs.statSync(withExtension).isFile()) {
        return assertInsidePluginRoot(withExtension);
      }
    }

    for (const ext of ALLOWED_EXTENSIONS) {
      const indexPath = path.join(resolvedPath, `index${ext}`);
      if (fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) {
        return assertInsidePluginRoot(indexPath);
      }
    }

    throw new Error(
      `Plugin "${options.pluginId}" import not found: ${specifier}`,
    );
  };

  const loadModule = (absolutePath: string): Record<string, unknown> => {
    const normalizedPath = path.resolve(absolutePath);
    const safePath = assertInsidePluginRoot(normalizedPath);

    const ext = path.extname(safePath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new Error(
        `Plugin "${options.pluginId}" entry/import must be JavaScript (.js/.mjs/.cjs): ${path.basename(safePath)}`,
      );
    }

    const cached = moduleCache.get(safePath);
    if (cached) {
      return cached;
    }

    const rawSource = fs.readFileSync(safePath, "utf-8");
    const source = transformPluginSource(rawSource, options.pluginId);
    const wrapperSource = `
(function(module, exports, require, __filename, __dirname) {
  "use strict";
${source}
})
`;

    const moduleRecord = vm.runInContext("({ exports: {} })", context) as {
      exports: Record<string, unknown>;
    };

    const localRequire = (specifier: string): Record<string, unknown> => {
      const resolved = resolveFile(safePath, specifier);
      return loadModule(resolved);
    };

    const wrapperFn = vm.runInContext(wrapperSource, context, {
      filename: safePath,
      displayErrors: true,
    }) as (
      module: { exports: Record<string, unknown> },
      exports: Record<string, unknown>,
      require: (specifier: string) => Record<string, unknown>,
      __filename: string,
      __dirname: string,
    ) => void;

    wrapperFn(
      moduleRecord,
      moduleRecord.exports,
      localRequire,
      safePath,
      path.dirname(safePath),
    );

    moduleCache.set(safePath, moduleRecord.exports);
    return moduleRecord.exports;
  };

  return {
    execute: async (entryFile: string): Promise<Record<string, unknown>> => {
      const resolvedEntry = path.resolve(entryFile);
      if (!fs.existsSync(resolvedEntry) || !fs.statSync(resolvedEntry).isFile()) {
        throw new Error(
          `Plugin "${options.pluginId}" entry file not found: ${resolvedEntry}`,
        );
      }
      return loadModule(resolvedEntry);
    },
    destroy: () => {
      for (const timeout of activeTimeouts) {
        clearTimeout(timeout);
      }
      activeTimeouts.clear();

      for (const interval of activeIntervals) {
        clearInterval(interval);
      }
      activeIntervals.clear();

      moduleCache.clear();
    },
  };
}
