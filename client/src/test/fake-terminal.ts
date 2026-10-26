// Stand-ins for a live terminal in jsdom: xterm, which needs a canvas, and the
// browser WebSocket. The real Terminal component and its connection hook run
// over them, so a suite can see the frames a session sends reach the screen
// and the keys typed into it go back out on the socket.
//
// Use from a suite with:
//   vi.mock("@xterm/xterm", () => import("../../test/fake-terminal"));
// plus stand-ins for "@xterm/addon-fit", "@xterm/addon-web-links" and the
// xterm stylesheet, and `vi.stubGlobal("WebSocket", FakeSocket)`.

type Listener<T> = (value: T) => void;

function disposable<T>(set: Set<Listener<T>>, listener: Listener<T>) {
  set.add(listener);
  return { dispose: () => set.delete(listener) };
}

/**
 * A stand-in for xterm's Terminal. `open` puts the screen and the input in the
 * container: the screen's text is everything written, and the input is a
 * textarea named "Terminal input", as xterm's own helper textarea is, whose
 * typed text reaches the `onData` listeners.
 */
export class Terminal {
  options: Record<string, unknown> = {};
  readonly parser = { registerOscHandler: () => ({ dispose: () => undefined }) };
  private readonly dataListeners = new Set<Listener<string>>();
  private readonly resizeListeners = new Set<Listener<{ cols: number; rows: number }>>();
  private screenEl: HTMLElement | null = null;
  private rootEl: HTMLElement | null = null;

  loadAddon(): void {}

  open(container: HTMLElement): void {
    const root = document.createElement("div");
    root.className = "xterm";
    const screen = document.createElement("div");
    screen.setAttribute("data-testid", "xterm-screen");
    const input = document.createElement("textarea");
    input.setAttribute("aria-label", "Terminal input");
    input.addEventListener("input", () => {
      const data = input.value;
      input.value = "";
      for (const listener of this.dataListeners) listener(data);
    });
    root.append(screen, input);
    container.append(root);
    this.screenEl = screen;
    this.rootEl = root;
  }

  write(data: string): void {
    if (this.screenEl) this.screenEl.textContent = `${this.screenEl.textContent ?? ""}${data}`;
  }

  onData(listener: Listener<string>) {
    return disposable(this.dataListeners, listener);
  }

  onResize(listener: Listener<{ cols: number; rows: number }>) {
    return disposable(this.resizeListeners, listener);
  }

  dispose(): void {
    this.rootEl?.remove();
    this.rootEl = null;
    this.screenEl = null;
    this.dataListeners.clear();
    this.resizeListeners.clear();
  }
}

export class FitAddon {
  fit(): void {}
  proposeDimensions() {
    return { cols: 80, rows: 24 };
  }
  dispose(): void {}
}

export class WebLinksAddon {
  dispose(): void {}
}

/**
 * A stand-in for the browser WebSocket. Every socket opened is kept in
 * `FakeSocket.opened`, it opens on the next microtask, `sent` holds the frames
 * the page sent, and `receive` delivers a frame from the server.
 */
export class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static opened: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  closed = false;
  readonly sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
    queueMicrotask(() => {
      if (this.closed) return;
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    });
  }

  /** The sockets opened to one terminal session. */
  static to(sessionId: string): FakeSocket[] {
    return FakeSocket.opened.filter((socket) => socket.url.endsWith(`/ws/terminal/${sessionId}`));
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeSocket.CLOSED;
  }
}
