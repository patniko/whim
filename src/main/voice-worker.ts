import { parentPort, workerData } from "worker_threads";
import { createVoiceInference } from "./voice-inference";

if (!parentPort) throw new Error("Speech inference must run in a worker");
const port = parentPort;
const inference = createVoiceInference(workerData.cacheDir);
port.on("message", (message: { id: number; audio: Float32Array | number[] }) => {
  void (async () => {
    const audio =
      message.audio instanceof Float32Array ? message.audio : new Float32Array(message.audio);
    if (!audio.every(Number.isFinite)) throw new Error("Voice audio contains invalid samples");
    const text = await inference.transcribeAudio(audio);
    port.postMessage({ id: message.id, text });
  })().catch((error) => {
    port.postMessage({
      id: message.id,
      error: error instanceof Error ? error.message : "Voice transcription failed",
    });
  });
});
