import { GoogleGenAI } from "@google/genai";

const geminiClientByKey = new Map<string, GoogleGenAI>();

export function getGeminiClient(apiKey: string): GoogleGenAI {
  const cached = geminiClientByKey.get(apiKey);
  if (cached) return cached;
  const client = new GoogleGenAI({ apiKey });
  geminiClientByKey.set(apiKey, client);
  return client;
}

/**
 * Retry wrapper for Gemini API calls that fail with 503 / overloaded errors.
 * Uses exponential backoff: 1s, 2s, 4s.
 */
export async function withGeminiRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient =
        msg.includes("503") ||
        msg.toLowerCase().includes("service unavailable") ||
        msg.toLowerCase().includes("overloaded");
      if (!isTransient || attempt === maxRetries) throw err;
      const delayMs = 2 ** attempt * 1000;
      console.warn(
        `[gemini] Transient error, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries}): ${msg}`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  // Unreachable but satisfies TypeScript
  throw new Error("withGeminiRetry exhausted");
}

/**
 * Helper to extract text from Gemini SDK responses.
 * The text property can be:
 * - a string (sync)
 * - a function returning a string (sync)
 * - a function returning a Promise<string> (async)
 */
export async function extractGeminiText(response: unknown): Promise<string> {
  const r = response as {
    text?: string | (() => string | Promise<string>) | (() => Promise<string>);
    output_text?: string;
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; thought?: boolean; thoughtSignature?: string }> };
    }>;
  };

  if (typeof r.text === "string" && r.text.trim()) return r.text;
  if (typeof r.text === "function") {
    const v = await r.text();
    if (typeof v === "string" && v.trim()) return v;
  }
  if (typeof r.output_text === "string" && r.output_text.trim()) {
    return r.output_text;
  }

  const textParts: string[] = [];
  const parts = r.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const p = part as { text?: string; thought?: boolean; thoughtSignature?: string };
    const isExplicitThought = p.thought === true;
    // Parts with thoughtSignature but WITHOUT thought: true are "signed" output text.
    // They should be included in the extracted text.
    if (!isExplicitThought && p.text) {
      textParts.push(p.text);
    }
  }

  return textParts.join("").trim();
}

/**
 * Helper to extract reasoning/thoughts from Gemini SDK responses.
 * Reasoning is returned in a part with a 'thought' boolean property
 * or a 'thoughtSignature'.
 */
export async function extractGeminiReasoning(response: unknown): Promise<string> {
  const r = response as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; thought?: boolean; thoughtSignature?: string }> };
    }>;
  };

  const thoughtParts: string[] = [];
  const parts = r.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const p = part as {
      text?: string;
      thought?: boolean;
      thoughtSignature?: string;
      role?: string;
    };
    const isThought = p.thought === true || p.thoughtSignature !== undefined;
    if (isThought && p.text) {
      thoughtParts.push(p.text);
    } else if (p.role === "thought" && p.text) {
      thoughtParts.push(p.text);
    }
  }

  return thoughtParts.join("\n\n").trim();
}
