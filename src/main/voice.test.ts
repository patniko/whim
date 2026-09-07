import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';

const mocks = vi.hoisted(() => ({
  importRuntime: vi.fn(),
  pipeline: vi.fn(),
  asr: vi.fn(),
  getPath: vi.fn(),
}));

async function loadVoice() {
  const { createVoiceInference } = await import('./voice-inference');
  return createVoiceInference(path.join(os.tmpdir(), 'whim-voice-test-unused', 'models'));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.doMock('@huggingface/transformers', () => {
    mocks.importRuntime();
    return { pipeline: mocks.pipeline };
  });
  mocks.getPath.mockReturnValue(path.join(os.tmpdir(), 'whim-voice-test-unused'));
  mocks.asr.mockResolvedValue({ text: ' hello world ' });
  mocks.pipeline.mockResolvedValue(mocks.asr);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.doUnmock('@huggingface/transformers');
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('lazy voice transcription', () => {
  it('does not import the runtime or load a model on module import or startup preload', async () => {
    vi.useFakeTimers();
    const voice = await loadVoice();
    expect(voice.preloadModel()).toBeUndefined();
    voice.preloadModel();
    await vi.runAllTimersAsync();

    expect(mocks.importRuntime).not.toHaveBeenCalled();
    expect(mocks.pipeline).not.toHaveBeenCalled();
    expect(mocks.getPath).not.toHaveBeenCalled();
  });

  it('loads on first use, preserves the cache and options, and reuses the model', async () => {
    const { transcribeAudio } = await loadVoice();
    const audio = new Float32Array([0, 0.25, -0.25]);
    expect(await transcribeAudio(audio)).toBe('hello world');
    expect(await transcribeAudio(audio)).toBe('hello world');

    expect(mocks.importRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.pipeline).toHaveBeenCalledExactlyOnceWith(
      'automatic-speech-recognition',
      'onnx-community/whisper-tiny.en',
      { cache_dir: path.join(os.tmpdir(), 'whim-voice-test-unused', 'models'), dtype: 'q8' },
    );
    expect(mocks.asr).toHaveBeenCalledWith(audio, { return_timestamps: false });
  });

  it('shares a pending model load across concurrent requests without polling', async () => {
    const load = deferred<typeof mocks.asr>();
    mocks.pipeline.mockReturnValueOnce(load.promise);
    const { transcribeAudio } = await loadVoice();
    const requests = Array.from({ length: 3 }, () => transcribeAudio(new Float32Array(1)));
    await vi.waitFor(() => expect(mocks.pipeline).toHaveBeenCalledTimes(1));
    expect(mocks.asr).not.toHaveBeenCalled();
    load.resolve(mocks.asr);

    expect(await Promise.all(requests)).toEqual(['hello world', 'hello world', 'hello world']);
    expect(mocks.pipeline).toHaveBeenCalledTimes(1);
  });

  it('rejects all concurrent callers with the load error, then permits a fresh retry', async () => {
    const load = deferred<typeof mocks.asr>();
    const error = new Error('Model unavailable');
    mocks.pipeline.mockReturnValueOnce(load.promise);
    const { transcribeAudio } = await loadVoice();
    const results = Promise.allSettled(
      Array.from({ length: 5 }, () => transcribeAudio(new Float32Array(1))),
    );
    await vi.waitFor(() => expect(mocks.pipeline).toHaveBeenCalledTimes(1));
    load.reject(error);

    expect(await results).toEqual(Array.from({ length: 5 }, () => ({
      status: 'rejected', reason: error,
    })));
    expect(mocks.asr).not.toHaveBeenCalled();
    expect(await transcribeAudio(new Float32Array(1))).toBe('hello world');
    expect(mocks.pipeline).toHaveBeenCalledTimes(2);
  });

  it('surfaces runtime import failures to every caller and retries the import', async () => {
    const error = new Error('Runtime unavailable');
    mocks.importRuntime.mockImplementationOnce(() => { throw error; });
    const { transcribeAudio } = await loadVoice();
    const results = await Promise.allSettled([
      transcribeAudio(new Float32Array(1)),
      transcribeAudio(new Float32Array(1)),
    ]);
    // Vitest wraps a failing module factory, retaining the original error as its cause.
    expect(results).toEqual(Array.from({ length: 2 }, () => ({
      status: 'rejected', reason: expect.objectContaining({ cause: error }),
    })));
    if (results[0].status === 'rejected' && results[1].status === 'rejected') {
      expect(results[0].reason).toBe(results[1].reason);
    }
    expect(mocks.pipeline).not.toHaveBeenCalled();
    expect(await transcribeAudio(new Float32Array(1))).toBe('hello world');
    expect(mocks.importRuntime).toHaveBeenCalledTimes(2);
  });

  it('bounds admission while loading and serializes inference in request order', async () => {
    const load = deferred<typeof mocks.asr>();
    mocks.pipeline.mockReturnValueOnce(load.promise);
    const gates = Array.from({ length: 5 }, () => deferred<{ text: string }>());
    for (const gate of gates) mocks.asr.mockReturnValueOnce(gate.promise);
    const { transcribeAudio } = await loadVoice();
    const audio = Array.from({ length: 5 }, (_, i) => new Float32Array([i]));
    const requests = audio.map(buffer => transcribeAudio(buffer));
    await expect(transcribeAudio(new Float32Array(1))).rejects.toThrow('Voice transcription is busy');
    load.resolve(mocks.asr);

    for (let i = 0; i < gates.length; i++) {
      await vi.waitFor(() => expect(mocks.asr).toHaveBeenCalledTimes(i + 1));
      expect(mocks.asr.mock.calls[i][0]).toBe(audio[i]);
      await expect(transcribeAudio(new Float32Array(1))).rejects.toThrow('Voice transcription is busy');
      gates[i].resolve({ text: ` result ${i} ` });
      expect(await requests[i]).toBe(`result ${i}`);
      // Replace the freed slot so admission remains full until all original requests finish.
      if (i < gates.length - 1) {
        requests.push(transcribeAudio(new Float32Array([5 + i])));
      }
    }
    await Promise.all(requests);
    expect(await transcribeAudio(new Float32Array(1))).toBe('hello world');
  });

  it('continues queued inference after an error without hiding the failed result', async () => {
    const inference = deferred<{ text: string }>();
    mocks.asr.mockReturnValueOnce(inference.promise);
    const { transcribeAudio } = await loadVoice();
    const first = transcribeAudio(new Float32Array(1));
    const failure = expect(first).rejects.toThrow('Inference failed');
    const second = transcribeAudio(new Float32Array(1));
    await vi.waitFor(() => expect(mocks.asr).toHaveBeenCalledTimes(1));
    inference.reject(new Error('Inference failed'));

    await failure;
    expect(await second).toBe('hello world');
    expect(await transcribeAudio(new Float32Array(1))).toBe('hello world');
    expect(mocks.pipeline).toHaveBeenCalledTimes(1);
  });

  it('preserves single, array, and empty transcription results', async () => {
    mocks.asr
      .mockResolvedValueOnce({ text: ' single ' })
      .mockResolvedValueOnce([{ text: 'first' }, { text: 'second' }])
      .mockResolvedValueOnce({ text: '' })
      .mockResolvedValueOnce([]);
    const { transcribeAudio } = await loadVoice();
    for (const expected of ['single', 'first second', '', '']) {
      expect(await transcribeAudio(new Float32Array(1))).toBe(expected);
    }
  });
});
