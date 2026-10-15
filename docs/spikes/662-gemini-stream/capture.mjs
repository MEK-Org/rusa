import { PcmFrames } from "./pcm.mjs";

class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = new PcmFrames(sampleRate);
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data !== "flush") return;
      this.stopped = true;
      this.frames.flush((bytes) => this.port.postMessage(bytes, [bytes]));
      this.port.postMessage({ flushed: true, samples: this.frames.samples });
    };
  }
  process(inputs) {
    const audio = inputs[0]?.[0];
    if (!this.stopped && audio) {
      this.frames.push(audio, (bytes) => this.port.postMessage(bytes, [bytes]));
    }
    return !this.stopped;
  }
}
registerProcessor("pcm-capture", Capture);
