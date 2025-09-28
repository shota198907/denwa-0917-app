class Pcm16EncoderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.decimation = Math.max(1, Math.round(sampleRate / this.targetRate));
    this.frameSize = 320; // 20 ms @ 16 kHz
    this.resetState();
  }

  resetState() {
    this.accumulator = 0;
    this.accCount = 0;
    this.frame = new Float32Array(this.frameSize);
    this.frameIndex = 0;
  }

  process(inputs) {
    const inputChannel = inputs?.[0]?.[0];
    if (!inputChannel) return true;

    for (let i = 0; i < inputChannel.length; i += 1) {
      this.accumulator += inputChannel[i];
      this.accCount += 1;

      if (this.accCount >= this.decimation) {
        const averaged = this.accumulator / this.accCount;
        this.accumulator = 0;
        this.accCount = 0;

        const clamped = Math.max(-1, Math.min(1, averaged));
        this.frame[this.frameIndex++] = clamped;

        if (this.frameIndex >= this.frame.length) {
          this.flushFrame();
        }
      }
    }

    return true;
  }

  flushFrame() {
    const buffer = new ArrayBuffer(this.frame.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < this.frame.length; i += 1) {
      const value = Math.max(-1, Math.min(1, this.frame[i] || 0));
      const sample = Math.round(value * 32767);
      view.setInt16(i * 2, sample, true);
    }

    this.port.postMessage({ type: "chunk", buffer }, [buffer]);
    this.frameIndex = 0;
  }
}

registerProcessor("pcm16-encoder", Pcm16EncoderProcessor);
