import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodePcmAudio, pcmToWav, resolveFfmpeg } from "./audio.js";

describe("pcmToWav", () => {
  it("produces a correct 44-byte RIFF header for known PCM bytes", () => {
    const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    const wav = pcmToWav(pcm, 24_000);

    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.readUInt32LE(16)).toBe(16); // PCM fmt chunk size
    expect(wav.readUInt16LE(20)).toBe(1); // PCM format tag
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(24_000); // sample rate
    expect(wav.readUInt32LE(28)).toBe(48_000); // byte rate = rate * block align
    expect(wav.readUInt16LE(32)).toBe(2); // block align
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.subarray(44).equals(pcm)).toBe(true);
  });

  it("derives byte rate and block align from channels/bits", () => {
    const wav = pcmToWav(Buffer.alloc(8), 16_000, 2, 16);
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt32LE(28)).toBe(64_000);
    expect(wav.readUInt16LE(32)).toBe(4);
  });
});

describe("encodePcmAudio", () => {
  it("falls back to WAV (with matching mime) when ffmpeg is unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-audio-"));
    const pcm = Buffer.from([9, 8, 7, 6]);
    const encoded = await encodePcmAudio(pcm, 24_000, join(dir, "out"), null);

    expect(encoded.path).toBe(join(dir, "out.wav"));
    expect(encoded.mime).toBe("audio/wav");
    const written = await readFile(encoded.path);
    expect(written.equals(pcmToWav(pcm, 24_000))).toBe(true);
  });

  it("falls back to WAV when the ffmpeg invocation itself fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-audio-"));
    const pcm = Buffer.from([1, 2]);
    const encoded = await encodePcmAudio(pcm, 24_000, join(dir, "out"), "/nonexistent/ffmpeg");

    expect(encoded.path).toBe(join(dir, "out.wav"));
    expect(encoded.mime).toBe("audio/wav");
    const written = await readFile(encoded.path);
    expect(written.equals(pcmToWav(pcm, 24_000))).toBe(true);
  });
});

describe("resolveFfmpeg", () => {
  it("finds an executable ffmpeg on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-ffmpeg-"));
    const fake = join(dir, "ffmpeg");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n");
    chmodSync(fake, 0o755);
    expect(resolveFfmpeg({ PATH: dir })).toBe(fake);
  });
});
