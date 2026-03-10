import {
  useDirectServices,
  BASE,
  handleResponse,
  handleVoidResponse,
  getServices,
} from "../helpers.js";
import type { AiMemoryRow } from "../../../storage/interface.js";

export async function getAiMemories(): Promise<AiMemoryRow[]> {
  if (useDirectServices()) {
    const svc = await getServices();
    return svc.storage.listAiMemories();
  }
  const res = await fetch(`${BASE}/ai/memories`);
  return handleResponse<AiMemoryRow[]>(res);
}

export async function updateAiMemory(
  id: string,
  content: string,
  category: AiMemoryRow["category"],
): Promise<void> {
  if (useDirectServices()) {
    const svc = await getServices();
    svc.storage.updateAiMemory(id, content, category);
    return;
  }
  await handleVoidResponse(
    await fetch(`${BASE}/ai/memories/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, category }),
    }),
  );
}

export async function deleteAiMemory(id: string): Promise<void> {
  if (useDirectServices()) {
    const svc = await getServices();
    svc.storage.deleteAiMemory(id);
    return;
  }
  await handleVoidResponse(
    await fetch(`${BASE}/ai/memories/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  );
}

export async function deleteAllAiMemories(): Promise<void> {
  if (useDirectServices()) {
    const svc = await getServices();
    const memories = svc.storage.listAiMemories();
    for (const m of memories) {
      svc.storage.deleteAiMemory(m.id);
    }
    return;
  }
  // Delete one by one since we don't have a bulk endpoint
  const memories = await getAiMemories();
  for (const m of memories) {
    await deleteAiMemory(m.id);
  }
}
