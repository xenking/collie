import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { pcm16, VoiceInput } from "./voice-input";

class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readonly send = vi.fn();
  readyState = FakeSocket.OPEN;
  binaryType = "blob";
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(_url: string) {
    FakeSocket.instances.push(this);
    queueMicrotask(() => this.emit({ kind: "ready" }));
  }

  close() {
    this.onclose?.();
  }

  emit(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
}

class FakeAudioContext {
  sampleRate = 48_000;
  currentTime = 0;
  destination = {} as AudioDestinationNode;
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  createMediaStreamSource = vi.fn(
    () => ({ connect: vi.fn(), disconnect: vi.fn() }) as unknown as MediaStreamAudioSourceNode,
  );
  createScriptProcessor = vi.fn(
    () => ({ connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null }) as unknown as ScriptProcessorNode,
  );
}

const stream = {
  getTracks: () => [{ stop: vi.fn() }],
} as unknown as MediaStream;

describe("VoiceInput", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    Object.defineProperty(window, "WebSocket", { configurable: true, value: FakeSocket });
    Object.defineProperty(window, "AudioContext", { configurable: true, value: FakeAudioContext });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => stream) },
    });
  });

  it("passes only the proxy's final transcript through the existing guarded reply seam", async () => {
    const onTranscript = vi.fn(async () => true);
    const onTranscriptChange = vi.fn();
    const onError = vi.fn();
    render(
      <StrictMode>
        <VoiceInput
          paneId="w1:p4"
          disabled={false}
          onTranscript={onTranscript}
          onTranscriptChange={onTranscriptChange}
          onError={onError}
        />
      </StrictMode>,
    );

    const button = screen.getByRole("button", { name: "Hold to talk" });
    fireEvent.keyDown(button, { key: " " });
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    await waitFor(() => expect(FakeSocket.instances[0].send).toHaveBeenCalledWith('{"kind":"start"}'));
    FakeSocket.instances[0].emit({ kind: "recording" });
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce());
    fireEvent.keyUp(button, { key: " " });
    FakeSocket.instances[0].emit({ kind: "transcript", text: "Привет" });
    FakeSocket.instances[0].emit({ kind: "final", text: "Привет" });

    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("Привет"));
    expect(onTranscriptChange).toHaveBeenCalledWith("Привет");
    expect(FakeSocket.instances[0].send).toHaveBeenCalledWith('{"kind":"handoff"}');
    expect(FakeSocket.instances[0].send).toHaveBeenCalledWith('{"kind":"end"}');
    expect(onError).not.toHaveBeenCalled();
  });

  it("downsamples microphone floats to Soniox's 16 kHz signed PCM", () => {
    expect(Array.from(pcm16(new Float32Array([1, -1, 0.5, -0.5]), 8_000))).toEqual([
      32767,
      32767,
      -32767,
      -32767,
      16384,
      16384,
      -16383,
      -16383,
    ]);
  });
});
