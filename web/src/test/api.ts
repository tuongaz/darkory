import { vi } from "vitest";

export type Call = { method: string; path: string; query: URLSearchParams; headers: Headers; body: unknown };
type Answer = Response | object | undefined;
export type Handler = Answer | ((call: Call & { params: Record<string, string> }) => Answer | Promise<Answer>);

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A reply with no body, as the Go server sends it: with Content-Length 0. */
export function empty(status: number): Response {
  return new Response(null, { status, headers: { "Content-Length": "0" } });
}

/** An Error body, as /v1 refuses. */
export function refuse(status: number, code: string, message: string): Response {
  return json(status, { code, message });
}

function match(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split("/");
  const got = path.split("/");
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(":")) params[want[i].slice(1)] = decodeURIComponent(got[i]);
    else if (want[i] !== got[i]) return null;
  }
  return params;
}

/**
 * Replaces fetch with a route table keyed "METHOD /v1/path/:param". A handler is the JSON reply,
 * a Response, or a function of the call. Unrouted requests answer 501, as unbuilt operations do.
 * Routes can be changed after rendering with `routes[...] = ...`.
 */
export function mockApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    const text = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // Not JSON, such as an Evidence upload.
    }
    const call: Call = { method: request.method, path: url.pathname, query: url.searchParams, headers: request.headers, body };
    calls.push(call);
    for (const [route, handler] of Object.entries(routes)) {
      const [method, pattern] = route.split(" ");
      const params = method === request.method ? match(pattern, url.pathname) : null;
      if (!params) continue;
      const answer = typeof handler === "function" ? await handler({ ...call, params }) : handler;
      if (answer instanceof Response) return answer.clone();
      if (answer === undefined) return empty(204);
      return json(200, answer);
    }
    return refuse(501, "not_implemented", `${request.method} ${url.pathname} is not built yet`);
  });
  vi.stubGlobal("fetch", fetch);
  return { routes, calls, fetch };
}
