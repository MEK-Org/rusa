import assert from "node:assert/strict";
import test from "node:test";
import { PcmFrames } from "./pcm.mjs";

test("irregular AudioWorklet callbacks preserve all samples and emit a short final frame", () => {
  const samples = Float32Array.from({ length: 16123 }, (_, i) => Math.sin(i / 7));
  const output = [];
  const packer = new PcmFrames(16000);
  for (let i = 0; i < samples.length; i += 128)
    packer.push(samples.subarray(i, i + 128), (b) => output.push(Buffer.from(b)));
  assert.equal(output.length, 10);
  packer.flush((b) => output.push(Buffer.from(b)));
  assert.equal(output.at(-1).length, 246);
  assert.equal(packer.samples, samples.length);
  const actual = Buffer.concat(output);
  assert.equal(actual.length, samples.length * 2);
  for (let i = 0; i < samples.length; i++)
    assert.equal(
      actual.readInt16LE(i * 2),
      Math.round(samples[i] * (samples[i] < 0 ? 32768 : 32767))
    );
  packer.flush(() => assert.fail("Second flush must emit nothing"));
});
test("clipping, NaN and byte order are explicit; unsupported native resampling fails", () => {
  const output = [];
  const packer = new PcmFrames(16000);
  packer.push([2, -2, NaN, 0.5, -0.5], (b) => output.push(Buffer.from(b)));
  packer.flush((b) => output.push(Buffer.from(b)));
  assert.deepEqual([...output[0]], [255, 127, 0, 128, 0, 0, 0, 64, 0, 192]);
  assert.throws(() => new PcmFrames(48000), /16 kHz/);
});
