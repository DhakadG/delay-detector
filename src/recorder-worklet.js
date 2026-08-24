// Captures mic input and stamps it with an absolute frame number, so the
// recording can be aligned exactly with the scheduled playback start.
class Recorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.startFrame = null;
  }

  flush() {
    if (this.n === 0) return;
    const chunk = this.buf.slice(0, this.n);
    this.port.postMessage({startFrame: this.startFrame, chunk}, [chunk.buffer]);
    this.n = 0;
    this.startFrame = null;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.startFrame === null) this.startFrame = currentFrame;
    if (this.n + ch.length > this.buf.length) this.flush();
    if (this.startFrame === null) this.startFrame = currentFrame;
    this.buf.set(ch, this.n);
    this.n += ch.length;
    return true;
  }
}
registerProcessor('recorder', Recorder);
