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
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  for (const pkg of manifest.packages) {
    for (const file of pkg.files) {
      if (file.url === requestUrl) {
        return { packageId: pkg.id, filePath: file.path };
      }
      // Allow same repo/revision/path even if the request used a CDN final URL
      // that no longer equals the manifest URL — only exact manifest URLs are
      // served here; engines must request via the pinned manifest URL.
    }
    // Kokoro voice seed after package patch:
    if (pkg.engine === "kokoro") {
      const voicePrefix = `https://huggingface.co/${pkg.repo}/resolve/junban-blocked/`;
      if (requestUrl.startsWith(voicePrefix)) {
        const rest = requestUrl.slice(voicePrefix.length);
        const hit = pkg.files.find((file) => file.path === rest);
        if (hit) return { packageId: pkg.id, filePath: hit.path };
      }
    }
  }
  void url;
  return null;
}

/**
 * Build a Transformers.js-compatible custom cache that only returns verified
 * OPFS objects. put() is rejected so engines cannot silently cache unverified
 * network bytes through this mediator.
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
      throw new Error(
        "Junban verified model cache refuses put(); only ensureVerifiedFile may admit bytes",
      );
    },
  };
}

function matchPackageFileUrl(pkg: LocalVoicePackage, url: string): string | null {
  for (const file of pkg.files) {
    if (file.url === url) return file.path;
  }
  if (pkg.engine === "kokoro") {
    const voicePrefix = `https://huggingface.co/${pkg.repo}/resolve/junban-blocked/`;
    if (url.startsWith(voicePrefix)) {
      const rest = url.slice(voicePrefix.length);
      if (pkg.files.some((file) => file.path === rest)) return rest;
    }
  }
  return null;
}
