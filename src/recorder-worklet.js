// Captures mic input and stamps it with an absolute frame number, so the
// recording can be aligned exactly with the scheduled playback start.
class Recorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.startFrame = null;
    this.silentBlocks = 0;
    this.totalBlocks = 0;
    // The main thread asks for a final flush before tearing the graph down.
    // Without it, up to 4096 samples (~85ms) sitting in the partial buffer
    // were silently dropped from the end of every capture.
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        this.flush();
        this.port.postMessage({done: true, silentBlocks: this.silentBlocks, totalBlocks: this.totalBlocks});
      }
    };
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

    // A stream that is connected but delivering pure digital silence means
    // the mic is muted or the OS handed us a dead device — worth reporting,
    // since it looks identical to "very quiet room" in the final numbers.
    this.totalBlocks++;
    let silent = true;
    for (let i = 0; i < ch.length; i++) { if (ch[i] !== 0) { silent = false; break; } }
    if (silent) this.silentBlocks++;

    if (this.n + ch.length > this.buf.length) this.flush();
    // stamped once per buffer: the frame of the sample about to land at buf[0]
    if (this.startFrame === null) this.startFrame = currentFrame;
    this.buf.set(ch, this.n);
    this.n += ch.length;
    return true;
  }
}
registerProcessor('recorder', Recorder);
