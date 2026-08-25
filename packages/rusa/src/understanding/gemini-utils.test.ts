import { describe, expect, it } from "vitest";
import { extractGeminiReasoning, extractGeminiText } from "./gemini-utils.js";

describe("gemini-utils", () => {
  describe("extractGeminiText", () => {
    it("extracts simple text", async () => {
      const response = {
        candidates: [{ content: { parts: [{ text: "hello" }] } }],
      };
      expect(await extractGeminiText(response)).toBe("hello");
    });

    it("extracts text from signed parts with thoughtSignature", async () => {
      const response = {
        candidates: [
          {
            content: {
              parts: [{ text: "signed text", thoughtSignature: "xyz" }],
            },
          },
        ],
      };
      expect(await extractGeminiText(response)).toBe("signed text");
    });

    it("skips explicit thought parts", async () => {
      const response = {
        candidates: [
          {
            content: {
              parts: [{ text: "thought", thought: true }, { text: "actual text" }],
            },
          },
        ],
      };
      expect(await extractGeminiText(response)).toBe("actual text");
    });

    it("handles multiple text parts", async () => {
      const response = {
        candidates: [
          {
            content: {
              parts: [{ text: "part 1 " }, { text: "part 2" }],
            },
          },
        ],
      };
      expect(await extractGeminiText(response)).toBe("part 1 part 2");
    });

    it("prefers r.text property if it exists", async () => {
      const response = {
        text: "direct text",
        candidates: [{ content: { parts: [{ text: "ignored" }] } }],
      };
      expect(await extractGeminiText(response)).toBe("direct text");
    });
  });

  describe("extractGeminiReasoning", () => {
    it("extracts thoughts with thought: true", async () => {
      const response = {
        candidates: [
          {
            content: {
              parts: [{ text: "my thought", thought: true }],
            },
          },
        ],
      };
      expect(await extractGeminiReasoning(response)).toBe("my thought");
    });

    it("extracts thoughts with thoughtSignature", async () => {
      const response = {
        candidates: [
          {
            content: {
              parts: [{ text: "signed thought", thoughtSignature: "abc" }],
            },
          },
        ],
      };
      expect(await extractGeminiReasoning(response)).toBe("signed thought");
    });

    it("extracts thoughts with role: 'thought'", async () => {
      const response = {
        candidates: [
          {
            content: {
              parts: [{ text: "role thought", role: "thought" }],
            },
          },
        ],
      };
      expect(await extractGeminiReasoning(response)).toBe("role thought");
    });
  });
});
