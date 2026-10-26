/* Mic ke samples jama karke 2048 ke block me main thread ko bhejta hai */
class STRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 2048;
    this.buf = new Float32Array(this.size);
    this.i = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    for (let k = 0; k < ch.length; k++) {
      this.buf[this.i++] = ch[k];
      if (this.i === this.size) {
        this.port.postMessage(this.buf.slice(0));
        this.i = 0;
      }
    }
    return true;
  }
}
registerProcessor("st-recorder", STRecorder);
