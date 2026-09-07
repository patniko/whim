import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

export function createVoiceInference(cacheDir: string) {
  let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
  let loading: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
  let inferenceTail: Promise<void> = Promise.resolve();
  let pendingTranscriptions = 0;

  const MODEL_ID = "onnx-community/whisper-tiny.en";
  // One active inference and at most four waiting requests, including model loading.
  const MAX_PENDING_TRANSCRIPTIONS = 5;

  async function getTranscriber(): Promise<AutomaticSpeechRecognitionPipeline> {
    if (transcriber) return transcriber;
    if (loading) return loading;

    loading = (async () => {
      console.log("[voice] Loading Whisper model...");
      const { pipeline } = await import("@huggingface/transformers");
      transcriber = (await pipeline("automatic-speech-recognition", MODEL_ID, {
        cache_dir: cacheDir,
        dtype: "q8",
      })) as AutomaticSpeechRecognitionPipeline;
      console.log("[voice] Model loaded");
      return transcriber;
    })();

    try {
      return await loading;
    } finally {
      loading = null;
    }
  }

  async function transcribeAudio(audioBuffer: Float32Array): Promise<string> {
    if (pendingTranscriptions >= MAX_PENDING_TRANSCRIPTIONS) {
      throw new Error(
        "Voice transcription is busy. Please try again when a pending transcription finishes.",
      );
    }

    pendingTranscriptions++;
    try {
      const asr = await getTranscriber();
      const inference = inferenceTail.then(() =>
        asr(audioBuffer, {
          return_timestamps: false,
        }),
      );
      // Keep the queue running after a failure; the caller still receives the rejection.
      inferenceTail = inference.then(
        () => {},
        () => {},
      );
      const result = await inference;

      if (Array.isArray(result)) {
        return result
          .map((r) => r.text)
          .join(" ")
          .trim();
      }
      return result.text?.trim() || "";
    } finally {
      pendingTranscriptions--;
    }
  }

  /**
   * Compatibility no-op for startup callers. Loading starts only on transcription;
   * startup orchestration should remove its preloadModel() call.
   */
  function preloadModel(): void {}
  return { transcribeAudio, preloadModel };
}
