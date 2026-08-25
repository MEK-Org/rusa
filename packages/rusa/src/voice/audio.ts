/**
 * Audio container handling for walkie-talkie mode : encode the raw PCM
 * Gemini TTS returns into something a browser/phone can play.
 *
 * Preferred path: ffmpeg (resolved from PATH plus `~/bin`, where prod keeps
 * it) → mp3 at 64 kbps, the same invocation the field-proven
 * `~/.rusa/tts.mjs` used. Fallback when ffmpeg is unavailable or fails:
 * wrap the PCM in a WAV header in pure TS — bigger file, universally playable.
 * The returned path/mime always reflect which encoding actually happened.
 */

import { execFile, spawn } from "node:child_process";
import { accessSync, constants, createWriteStream } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface EncodedAudio {
  /** Absolute path of the written file (`<basePath>.mp3` or `<basePath>.wav`). */
  path: string;
  /** `audio/mpeg` for mp3, `audio/wav` for the fallback. */
  mime: string;
}

export interface StreamingEncodedAudio {
  path: string;
  mime: string;
  /** Returns true if subscribed to live stream, false if finished and caller must read the static file. */
  subscribe: (onData: (chunk: Buffer) => void, onEnd: () => void) => boolean;
}

/**
 * Wrap 16-bit little-endian mono/interleaved PCM in a canonical 44-byte RIFF
 * WAV header. Pure TS — the no-ffmpeg fallback container.
 */
export function pcmToWav(
  pcm: Buffer,
  sampleRate: number,
  channels = 1,
  bitsPerSample = 16
): Buffer {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4); // RIFF chunk size
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  header.writeUInt16LE(1, 20); // audio format: PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Find an executable ffmpeg: every PATH entry, then `~/bin` (where prod keeps
 * its static build). Returns null when none is executable.
 */
export function resolveFfmpeg(env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = [...(env.PATH ?? "").split(delimiter).filter(Boolean), join(homedir(), "bin")];
  for (const dir of dirs) {
    const candidate = join(dir, "ffmpeg");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here — keep looking
    }
  }
  return null;
}

/**
 * Write PCM to `<basePath>.mp3` via ffmpeg when available, else `<basePath>.wav`
 * via {@link pcmToWav}. `ffmpegPath` is injectable for tests (pass null to force
 * the WAV path); defaults to {@link resolveFfmpeg}'s answer.
 */
export async function encodePcmAudio(
  pcm: Buffer,
  sampleRate: number,
  basePath: string,
  ffmpegPath: string | null = resolveFfmpeg()
): Promise<EncodedAudio> {
  if (ffmpegPath) {
    const rawPath = `${basePath}.pcm`;
    const mp3Path = `${basePath}.mp3`;
    try {
      await writeFile(rawPath, pcm);
      await execFileAsync(ffmpegPath, [
        "-y",
        "-f",
        "s16le",
        "-ar",
        String(sampleRate),
        "-ac",
        "1",
        "-i",
        rawPath,
        "-b:a",
        "64k",
        mp3Path,
      ]);
      return { path: mp3Path, mime: "audio/mpeg" };
    } catch (err) {
      console.warn(
        `[voice] ffmpeg encode failed, falling back to WAV: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    } finally {
      await unlink(rawPath).catch(() => {});
    }
  }
  const wavPath = `${basePath}.wav`;
  await writeFile(wavPath, pcmToWav(pcm, sampleRate));
  return { path: wavPath, mime: "audio/wav" };
}

/**
 * Streaming version of encodePcmAudio.
 */
export async function encodePcmStream(
  pcmStream: AsyncIterable<Buffer>,
  sampleRate: number,
  basePath: string,
  ffmpegPath: string | null = resolveFfmpeg()
): Promise<StreamingEncodedAudio> {
  const mp3Path = `${basePath}.mp3`;
  const wavPath = `${basePath}.wav`;

  if (ffmpegPath) {
    const ffmpeg = spawn(ffmpegPath, [
      "-y",
      "-f",
      "s16le",
      "-ar",
      String(sampleRate),
      "-ac",
      "1",
      "-i",
      "pipe:0",
      "-b:a",
      "64k",
      "-f",
      "mp3",
      "pipe:1",
    ]);

    let mp3Chunks: Buffer[] | null = [];
    let isDone = false;
    const fileStream = createWriteStream(mp3Path);
    const listeners = new Set<{ onData: (c: Buffer) => void; onEnd: () => void }>();

    ffmpeg.stdout.on("data", (chunk) => {
      if (mp3Chunks) mp3Chunks.push(chunk);
      fileStream.write(chunk);
      for (const l of listeners) l.onData(chunk);
    });
    ffmpeg.stdout.on("end", () => {
      isDone = true;
      mp3Chunks = null;
      fileStream.end();
      for (const l of listeners) l.onEnd();
      listeners.clear();
    });
    ffmpeg.on("error", (err) => {
      console.warn(`[voice] streaming ffmpeg error: ${err.message}`);
    });

    (async () => {
      try {
        for await (const chunk of pcmStream) {
          if (!ffmpeg.stdin.write(chunk)) {
            await new Promise((resolve) => ffmpeg.stdin.once("drain", resolve));
          }
        }
        ffmpeg.stdin.end();
      } catch {
        ffmpeg.kill();
      }
    })();

    return {
      path: mp3Path,
      mime: "audio/mpeg",
      subscribe: (onData, onEnd) => {
        if (isDone) return false;
        for (const chunk of mp3Chunks || []) onData(chunk);
        listeners.add({ onData, onEnd });
        return true;
      },
    };
  } else {
    // Fallback: wait for all chunks then WAV
    const chunks: Buffer[] = [];
    for await (const chunk of pcmStream) {
      chunks.push(chunk);
    }
    const fullPcm = Buffer.concat(chunks);
    const wav = pcmToWav(fullPcm, sampleRate);
    await writeFile(wavPath, wav);
    return {
      path: wavPath,
      mime: "audio/wav",
      subscribe: () => false, // immediately tell caller to use static file
    };
  }
}
