// Emits the stimulus AND captures the microphone, in the same processor.
//
// Why both jobs live here: the delay is (arrival frame - emission frame), so those two
// numbers must come from ONE clock. The previous design played the stimulus from an
// AudioBufferSourceNode scheduled off `ctx.currentTime` on the main thread, while the
// capture was frame-stamped with `currentFrame` on the audio thread. Those two clocks are
// read at different moments and quantised differently, and the gap between them wandered
// by up to ~512 frames (~10.7 ms at 48 kHz) from one run to the next. That landed directly
// in the answer: a wired HDMI output whose six repeats agreed to 0.03 ms within a run still
// swung 61-76 ms BETWEEN runs, and a device measured against itself showed a 22 ms range
// instead of ~0.
//
// Emitting from inside the processor removes the second clock entirely. `emitFrame` is the
// exact frame at which stimulus sample 0 left this node, recorded by the same counter that
// stamps the captured blocks, so the alignment is exact by construction rather than
// inferred from scheduling.
class Recorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.startFrame = null;

    this.stimulus = null;   // Float32Array to emit, or null for capture-only
    this.stimPos = 0;
    this.emitFrame = null;  // frame at which stimulus[0] was emitted
    this.emitDone = false;

    this.silentBlocks = 0;
    this.totalBlocks = 0;

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg === 'flush') {
        this.flush();
        this.port.postMessage({
          done: true,
          emitFrame: this.emitFrame,
          silentBlocks: this.silentBlocks,
          totalBlocks: this.totalBlocks,
          emitDone: this.emitDone,
        });
        return;
      }
      if (msg && msg.stimulus) {
        this.stimulus = new Float32Array(msg.stimulus);
        this.stimPos = 0;
        this.emitFrame = null;
        this.emitDone = false;
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

  process(inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    const ch = inputs[0] && inputs[0][0];

    // --- emit ---
    if (out) {
      const blockLen = out.length;
      if (this.stimulus && this.stimPos < this.stimulus.length) {
        // Stamp the exact frame stimulus sample 0 goes out. `currentFrame` is the frame
        // index of the first sample of this render quantum, and we always start emitting
        // at sample 0 of a quantum, so this is exact rather than approximate.
        if (this.emitFrame === null) this.emitFrame = currentFrame;
        const n = Math.min(blockLen, this.stimulus.length - this.stimPos);
        for (let i = 0; i < n; i++) out[i] = this.stimulus[this.stimPos + i];
        for (let i = n; i < blockLen; i++) out[i] = 0;
        this.stimPos += n;
        if (this.stimPos >= this.stimulus.length) this.emitDone = true;
      } else {
        out.fill(0);
      }
    }

    // --- capture ---
    if (ch) {
      // A connected stream delivering pure digital silence means a muted or dead input;
      // that looks identical to "very quiet room" once it reaches the correlator, so count
      // it here where the difference is still visible.
      this.totalBlocks++;
      let silent = true;
      for (let i = 0; i < ch.length; i++) { if (ch[i] !== 0) { silent = false; break; } }
      if (silent) this.silentBlocks++;

      if (this.n + ch.length > this.buf.length) this.flush();
      // Stamped once per buffer: the frame of the sample about to land at buf[0].
      if (this.startFrame === null) this.startFrame = currentFrame;
      this.buf.set(ch, this.n);
      this.n += ch.length;
    }

    return true;
  }
}
registerProcessor('recorder', Recorder);
