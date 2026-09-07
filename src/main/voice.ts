import { Worker } from "worker_threads";
import { app } from "electron";
import * as path from "path";

const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const pending = new Map<
  number,
  {
    resolve: (text: string) => void;
    reject: (error: Error) => void;
    bytes: number;
  }
>();
let worker: Worker | undefined;
let sequence = 0;
let pendingBytes = 0;

function rejectPending(error: Error): void {
  for (const request of pending.values()) request.reject(error);
  pending.clear();
  pendingBytes = 0;
}

function getWorker(): Worker {
  if (worker) return worker;
  const instance = new Worker(path.join(__dirname, "voice-worker.js"), {
    workerData: { cacheDir: path.join(app.getPath("userData"), "models") },
  });
  worker = instance;
  instance.unref();
  instance.on("message", (message: { id: number; text?: string; error?: string }) => {
    if (instance !== worker) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    pendingBytes -= request.bytes;
    if (message.error) request.reject(new Error(message.error));
    else if (typeof message.text === "string") request.resolve(message.text);
    else request.reject(new Error("Invalid voice worker response"));
  });
  instance.on("error", (error) => {
    if (worker !== instance) return;
    worker = undefined;
    rejectPending(error);
  });
  instance.on("exit", (code) => {
    if (worker !== instance) return;
    worker = undefined;
    rejectPending(new Error(`Voice worker exited (${code}); retry transcription`));
  });
  return instance;
}

export function transcribeAudio(audio: Float32Array | number[]): Promise<string> {
  if (!(audio instanceof Float32Array) && !Array.isArray(audio))
    return Promise.reject(new Error("Invalid voice audio"));
  const bytes = audio.length * Float32Array.BYTES_PER_ELEMENT;
  if (bytes === 0 || bytes > MAX_AUDIO_BYTES)
    return Promise.reject(
      new Error("Voice audio must contain between 1 sample and 32 MiB of PCM data"),
    );
  if (pending.size >= 5 || pendingBytes + bytes > MAX_AUDIO_BYTES)
    return Promise.reject(
      new Error(
        "Voice transcription is busy. Please try again when a pending transcription finishes.",
      ),
    );
  return new Promise((resolve, reject) => {
    const instance = getWorker();
    const id = ++sequence;
    pending.set(id, { resolve, reject, bytes });
    pendingBytes += bytes;
    try {
      instance.postMessage({ id, audio });
    } catch (error) {
      pending.delete(id);
      pendingBytes -= bytes;
      reject(error);
    }
  });
}

export async function shutdownVoice(): Promise<void> {
  const instance = worker;
  worker = undefined;
  rejectPending(new Error("Voice transcription stopped; audio was not saved"));
  if (instance) await instance.terminate();
}

/** Startup does not load speech or start its worker. */
export function preloadModel(): void {}
