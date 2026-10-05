/** Stands in for the browser's EventSource, which jsdom lacks; tests push events through it. */
export class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readonly withCredentials: boolean;
  readyState = FakeEventSource.CONNECTING;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;

  constructor(url: string | URL, init?: EventSourceInit) {
    super();
    this.url = String(url);
    this.withCredentials = init?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }

  static latest(): FakeEventSource {
    const s = FakeEventSource.instances.at(-1);
    if (!s) throw new Error("no EventSource was opened");
    return s;
  }

  open() {
    this.readyState = FakeEventSource.OPEN;
    const e = new Event("open");
    this.onopen?.(e);
    this.dispatchEvent(e);
  }

  /** Delivers one SSE event, as the server would send `event: <type>`, `id: <id>`, `data: <json>`. */
  emit(type: string, data: unknown, id?: number) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data), lastEventId: id === undefined ? "" : String(id) }));
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}
