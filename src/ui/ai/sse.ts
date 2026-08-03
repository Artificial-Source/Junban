/**
 * Bounded local AI SSE surface (compatibility barrel).
 *
 * Split ownership:
 * - `sse-decoder.ts` — incremental framing
 * - `sse-reducer.ts` — pure envelope/run reduction
 * - `sse-stream.ts` — fetch body pump and raf batching
 */

export { AiSseDecoder, type DecodedSseFrame } from "./sse-decoder";
export { AiRunSseReducer } from "./sse-reducer";
export {
  consumeAiRunSseStream,
  createVisibleTextFrameBatcher,
  type AiRunStreamHandlers,
} from "./sse-stream";
