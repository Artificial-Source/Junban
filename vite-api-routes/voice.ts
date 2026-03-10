import type { RouteRegistrar } from "./types.js";
import { parseBody } from "./types.js";

export const registerVoiceRoutes: RouteRegistrar = (server, _getServices) => {
  // POST /api/voice/transcribe — proxy to Groq STT
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/voice/transcribe" || req.method !== "POST") return next();

    try {
      const apiKey = req.headers["x-api-key"] as string;
      if (!apiKey) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Missing API key" }));
        return;
      }

      // Collect raw body for multipart forwarding
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const bodyBuffer = Buffer.concat(chunks);

      const groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": req.headers["content-type"]!,
        },
        body: bodyBuffer,
      });

      const data = await groqRes.text();
      res.statusCode = groqRes.status;
      res.setHeader("Content-Type", "application/json");
      res.end(data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Transcription proxy error";
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: message }));
    }
  });

  // POST /api/voice/synthesize — proxy to Groq TTS
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/voice/synthesize" || req.method !== "POST") return next();

    try {
      const apiKey = req.headers["x-api-key"] as string;
      if (!apiKey) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Missing API key" }));
        return;
      }

      const body = await parseBody(req);

      const groqRes = await fetch("https://api.groq.com/openai/v1/audio/speech", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!groqRes.ok) {
        const errText = await groqRes.text();
        res.statusCode = groqRes.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: errText }));
        return;
      }

      const audioBuffer = await groqRes.arrayBuffer();
      res.setHeader("Content-Type", "audio/wav");
      res.end(Buffer.from(audioBuffer));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Synthesis proxy error";
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: message }));
    }
  });

  // POST /api/voice/inworld-synthesize — streaming proxy to Inworld AI TTS
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/voice/inworld-synthesize" || req.method !== "POST") return next();

    try {
      const apiKey = req.headers["x-api-key"] as string;
      if (!apiKey) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Missing API key" }));
        return;
      }

      const body = await parseBody(req);

      const inworldRes = await fetch("https://api.inworld.ai/tts/v1/voice:stream", {
        method: "POST",
        headers: {
          Authorization: `Basic ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!inworldRes.ok) {
        const errText = await inworldRes.text();
        res.statusCode = inworldRes.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: errText }));
        return;
      }

      res.setHeader("Content-Type", "audio/mpeg");

      // Parse NDJSON stream: each line is {"result":{"audioContent":"<base64>",...}}
      const reader = inworldRes.body!.getReader();
      const decoder = new TextDecoder();
      let ndjsonBuf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        ndjsonBuf += decoder.decode(value, { stream: true });

        // Process complete lines
        while (ndjsonBuf.includes("\n")) {
          const idx = ndjsonBuf.indexOf("\n");
          const line = ndjsonBuf.slice(0, idx).trim();
          ndjsonBuf = ndjsonBuf.slice(idx + 1);

          if (!line) continue;
          try {
            const chunk = JSON.parse(line);
            if (chunk.error) {
              // Stream-level error from Inworld
              if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader("Content-Type", "application/json");
              }
              res.end(JSON.stringify({ error: chunk.error.message ?? "Inworld stream error" }));
              return;
            }
            const audioB64 = chunk.result?.audioContent;
            if (audioB64) {
              res.write(Buffer.from(audioB64, "base64"));
            }
          } catch {
            // Skip malformed NDJSON lines
          }
        }
      }

      res.end();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Inworld synthesis proxy error";
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
      }
      res.end(JSON.stringify({ error: message }));
    }
  });

  // GET /api/voice/inworld-voices — proxy to Inworld AI voice list
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/voice/inworld-voices" || req.method !== "GET") return next();

    try {
      const apiKey = req.headers["x-api-key"] as string;
      if (!apiKey) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Missing API key" }));
        return;
      }

      const inworldRes = await fetch("https://api.inworld.ai/tts/v1/voices", {
        headers: {
          Authorization: `Basic ${apiKey}`,
        },
      });

      if (!inworldRes.ok) {
        const errText = await inworldRes.text();
        res.statusCode = inworldRes.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: errText }));
        return;
      }

      const data = await inworldRes.json();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(data));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Inworld voices proxy error";
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: message }));
    }
  });
};
