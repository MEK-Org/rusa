// The AudioContext requests native 16 kHz resampling. This packer preserves frame
// boundaries and emits little-endian signed PCM, including a short final frame.
export class PcmFrames {
  constructor(inputRate, frameSamples = 1600) {
    if (inputRate !== 16000) throw new Error("Browser did not provide a 16 kHz AudioContext");
    this.frame = new Int16Array(frameSamples);
    this.used = 0;
    this.samples = 0;
  }
  push(input, emit) {
    for (const value of input) {
      const sample = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
      this.frame[this.used++] = Math.round(sample * (sample < 0 ? 32768 : 32767));
      this.samples++;
      if (this.used === this.frame.length) this.flush(emit);
    }
  }
  flush(emit) {
    if (!this.used) return;
    const bytes = new ArrayBuffer(this.used * 2);
    const view = new DataView(bytes);
    for (let i = 0; i < this.used; i++) view.setInt16(i * 2, this.frame[i], true);
    this.used = 0;
    emit(bytes);
  }
}
