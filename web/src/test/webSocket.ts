/**
 * Stands in for the browser's WebSocket, which jsdom lacks; tests play the server through it:
 * `open()`, `receive(bytes)`, `serverClose()`, and read what the page sent in `sent`.
 */
export class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  binaryType: BinaryType = "blob";
  /** What the page sent: strings as text frames, bytes as binary ones. */
  sent: (string | Uint8Array)[] = [];
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  static latest(): FakeWebSocket {
    const s = FakeWebSocket.instances.at(-1);
    if (!s) throw new Error("no WebSocket was opened");
    return s;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("send on a WebSocket that is not open");
    if (typeof data === "string") this.sent.push(data);
    else if (ArrayBuffer.isView(data)) this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    else this.sent.push(new Uint8Array(data));
  }

  close(code = 1000) {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.fire(new CloseEvent("close", { code, wasClean: true }));
  }

  /** The server accepts the upgrade. */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.fire(new Event("open"));
  }

  /** A message from the server: bytes as a binary frame (an ArrayBuffer), a string as text. */
  receive(data: string | Uint8Array) {
    const payload = typeof data === "string" ? data : data.slice().buffer;
    this.fire(new MessageEvent("message", { data: payload }));
  }

  /** The server or the network ends the connection. */
  serverClose(code = 1006) {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.fire(new CloseEvent("close", { code, wasClean: code !== 1006 }));
  }

  /** Text frames the page sent, parsed as JSON. */
  textFrames(): unknown[] {
    return this.sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d));
  }

  /** Binary frames the page sent, decoded as text. */
  typed(): string {
    return this.sent
      .filter((d): d is Uint8Array => typeof d !== "string")
      .map((d) => new TextDecoder().decode(d))
      .join("");
  }

  private fire(e: Event) {
    const handler = { open: this.onopen, message: this.onmessage, close: this.onclose, error: this.onerror }[e.type] as ((e: Event) => void) | null;
    handler?.(e);
    this.dispatchEvent(e);
  }
}
