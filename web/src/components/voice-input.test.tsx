import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { pcm16, VoiceInput } from "./voice-input";

class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  static autoReady = true;
  readonly send = vi.fn();
  readyState = FakeSocket.OPEN;
  binaryType = "blob";
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(_url: string) {
    FakeSocket.instances.push(this);
    if (FakeSocket.autoReady) queueMicrotask(() => this.emit({ kind: "ready" }));
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
    FakeSocket.autoReady = true;
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
          mode="toggle"
          disabled={false}
          onTranscript={onTranscript}
          onTranscriptChange={onTranscriptChange}
          onError={onError}
        />
      </StrictMode>,
    );

    const button = screen.getByRole("button", { name: "Start voice input" });
    fireEvent.click(button);
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    await waitFor(() => expect(FakeSocket.instances[0].send).toHaveBeenCalledWith('{"kind":"start"}'));
    FakeSocket.instances[0].emit({ kind: "recording" });
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Stop and send voice input" }));
    FakeSocket.instances[0].emit({ kind: "transcript", text: "Привет" });
    FakeSocket.instances[0].emit({ kind: "final", text: "Привет" });

    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("Привет"));
    expect(onTranscriptChange).toHaveBeenCalledWith("Привет");
    expect(FakeSocket.instances[0].send).toHaveBeenCalledWith('{"kind":"handoff"}');
    expect(FakeSocket.instances[0].send).toHaveBeenCalledWith('{"kind":"end"}');
    expect(onError).not.toHaveBeenCalled();
  });

  it("stops an active voice turn on its second click", async () => {
    render(
      <VoiceInput
        paneId="w1:p4"
        mode="toggle"
        disabled={false}
        onTranscript={vi.fn(async () => true)}
        onTranscriptChange={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const button = screen.getByRole("button", { name: "Start voice input" });
    fireEvent.click(button);
    await waitFor(() => expect(FakeSocket.instances[0].send).toHaveBeenCalledWith('{"kind":"start"}'));
    fireEvent.click(screen.getByRole("button", { name: "Stop and send voice input" }));
    expect(FakeSocket.instances[0].send).toHaveBeenCalledWith('{"kind":"end"}');
  });

  it("ends only on release in push-to-talk mode", async () => {
    render(
      <VoiceInput
        paneId="w1:p4"
        mode="push-to-talk"
        disabled={false}
        onTranscript={vi.fn(async () => true)}
        onTranscriptChange={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const button = screen.getByRole("button", { name: "Hold to talk" });
    Object.defineProperty(button, "setPointerCapture", { value: vi.fn() });
    fireEvent.pointerDown(button, { pointerId: 1, isPrimary: true });
    await waitFor(() => expect(FakeSocket.instances[0].send).toHaveBeenCalledWith('{"kind":"start"}'));
    fireEvent.pointerUp(button, { pointerId: 1, isPrimary: true });
    expect(FakeSocket.instances[0].send).toHaveBeenCalledWith('{"kind":"end"}');
  });

  it("returns to idle when the second click ends a socket still connecting", async () => {
    FakeSocket.autoReady = false;
    render(
      <VoiceInput
        paneId="w1:p4"
        disabled={false}
        mode="toggle"
        onTranscript={vi.fn(async () => true)}
        onTranscriptChange={vi.fn()}
        onError={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Stop and send voice input" }));
    FakeSocket.instances[0].emit({ kind: "ready" });

    await waitFor(() => expect(screen.getByRole("button", { name: "Start voice input" })).toBeInTheDocument());
    expect(FakeSocket.instances[0].send).toHaveBeenCalledWith('{"kind":"release"}');
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
