/**
 * Fail-closed model cache mediation for Transformers.js / Kokoro.
 *
 * This is a loader/cache boundary only — it does not download models and does
 * not run inference. It serves only bytes that already passed Junban's
 * manifest + OPFS verification. Remote network fallback is never performed.
 */

import { getLocalVoicePackage, LOCAL_VOICE_MANIFEST } from "./manifest.ts";
import { openVerifiedFile } from "./opfs-store.ts";
import type { LocalVoiceManifest, LocalVoicePackage } from "./types.ts";

export type VerifiedCacheLookup = {
  packageId: string;
  filePath: string;
};

/**
 * Map a request URL to a verified package file when the URL matches a
 * committed manifest entry (or the Junban-blocked voice style seed URL).
 */
export function matchManifestUrl(
  requestUrl: string,
  manifest: LocalVoiceManifest = LOCAL_VOICE_MANIFEST,
): VerifiedCacheLookup | null {
  for (const pkg of manifest.packages) {
    const path = matchPackageFileUrl(pkg, requestUrl);
    if (path) return { packageId: pkg.id, filePath: path };
  }
  return null;
}

/**
 * Build a Transformers.js-compatible custom cache that only returns verified
 * OPFS objects. put() is a no-op so engines cannot admit unverified bytes.
 */
export function createVerifiedTransformersCache(
  packageId: string,
  manifest: LocalVoiceManifest = LOCAL_VOICE_MANIFEST,
): {
  match: (request: RequestInfo | URL) => Promise<Response | undefined>;
  put: (request: RequestInfo | URL, response: Response) => Promise<void>;
} {
  const pkg = getLocalVoicePackage(packageId, manifest);
  return {
    async match(request) {
      const url =
        typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
      const hit = matchPackageFileUrl(pkg, url);
      if (!hit) return undefined;
      const file = await openVerifiedFile(packageId, hit);
      if (!file) return undefined;
      // Response(Blob/File) streams when the runtime supports it; avoids manual full copies.
      return new Response(file, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(file.size),
          "X-Junban-Verified": "1",
        },
      });
    },
    async put() {
      // Transformers.js may call put() after a successful match. Never admit new
      // bytes here — OPFS admission is solely ensureVerifiedFile (size+SHA).
      return;
    },
  };
}

/**
 * Resolve a transformers.js cache key to a verified package-relative path.
 *
 * Keys observed from transformers.js / kokoro-js:
 * - exact pinned HF resolve/<revision>/<path> (manifest URL)
 * - HF resolve/main/<path> when a library omits revision (kokoro-js default)
 * - junban-blocked voice seed URLs (patched kokoro voice loader)
 * - localModelPath forms: /models/<repo>/<path> and models/<repo>/<path>
 */
export function matchPackageFileUrl(pkg: LocalVoicePackage, url: string): string | null {
  for (const file of pkg.files) {
    if (file.url === url) return file.path;
  }

  // Strip query/hash if a full URL was passed with tracking noise.
  let pathname = url;
  try {
    if (url.includes("://")) {
      pathname = new URL(url).pathname;
    }
  } catch {
    pathname = url;
  }

  const hfPinnedPrefix = `/${pkg.repo}/resolve/${pkg.revision}/`;
  const hfMainPrefix = `/${pkg.repo}/resolve/main/`;
  const hfBlockedPrefix = `/${pkg.repo}/resolve/junban-blocked/`;
  const localPrefixA = `/models/${pkg.repo}/`;
  const localPrefixB = `models/${pkg.repo}/`;

  let rest: string | null = null;
  if (pathname.startsWith(hfPinnedPrefix)) {
    rest = pathname.slice(hfPinnedPrefix.length);
  } else if (pathname.startsWith(hfMainPrefix)) {
    // kokoro-js does not forward revision; map main → pinned verified bytes only.
    rest = pathname.slice(hfMainPrefix.length);
  } else if (pkg.engine === "kokoro" && pathname.startsWith(hfBlockedPrefix)) {
    rest = pathname.slice(hfBlockedPrefix.length);
  } else if (pathname.startsWith(localPrefixA)) {
    rest = pathname.slice(localPrefixA.length);
  } else if (pathname.startsWith(localPrefixB)) {
    rest = pathname.slice(localPrefixB.length);
  } else if (!url.includes("://") && !url.startsWith("/")) {
    // requestURL style: "<repo>/<file>" without models/ prefix
    const repoPrefix = `${pkg.repo}/`;
    if (url.startsWith(repoPrefix)) {
      rest = url.slice(repoPrefix.length);
    }
  }

  if (rest == null || rest.length === 0 || rest.includes("..")) {
    return null;
  }
  // decodeURI in case path segments were encoded
  try {
    rest = decodeURIComponent(rest);
  } catch {
    return null;
  }
  if (pkg.files.some((file) => file.path === rest)) {
    return rest;
  }
  return null;
}
