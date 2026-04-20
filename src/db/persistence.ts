import { isTauri } from "../utils/tauri.js";
import { isRemoteDesktopRuntime } from "../utils/runtime.js";

const DB_DIR = "ASF Junban";
const DB_FILE = "junban.db";
const REMOTE_DB_FILE_ACCESS_DISABLED_ERROR =
  "Remote-desktop clients must use the backend API; direct database file access is disabled.";

async function loadTauriFs() {
  return import("@tauri-apps/plugin-fs");
}

export async function loadDbFile(): Promise<Uint8Array | null> {
  if (isRemoteDesktopRuntime()) {
    throw new Error(REMOTE_DB_FILE_ACCESS_DISABLED_ERROR);
  }

  if (!isTauri()) {
    return null;
  }

  try {
    const { readFile, exists, BaseDirectory } = await loadTauriFs();
    const dirExists = await exists(DB_DIR, { baseDir: BaseDirectory.AppData });
    if (!dirExists) return null;
    return await readFile(`${DB_DIR}/${DB_FILE}`, {
      baseDir: BaseDirectory.AppData,
    });
  } catch {
    return null;
  }
}

export async function saveDbFile(data: Uint8Array): Promise<void> {
  if (isRemoteDesktopRuntime()) {
    throw new Error(REMOTE_DB_FILE_ACCESS_DISABLED_ERROR);
  }

  if (!isTauri()) {
    return;
  }

  const { writeFile, mkdir, BaseDirectory } = await loadTauriFs();
  await mkdir(DB_DIR, { baseDir: BaseDirectory.AppData, recursive: true });
  await writeFile(`${DB_DIR}/${DB_FILE}`, data, {
    baseDir: BaseDirectory.AppData,
  });
}
