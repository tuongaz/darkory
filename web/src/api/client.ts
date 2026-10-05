import createClient, { type Middleware } from "openapi-fetch";
import type { components, paths } from "./schema.gen";

type Schemas = components["schemas"];
export type Activity = Schemas["Activity"];
export type ActivityPage = Schemas["ActivityPage"];
export type Claim = Schemas["Claim"];
export type ErrorBody = Schemas["Error"];
export type Evidence = Schemas["Evidence"];
export type Feature = Schemas["Feature"];
export type FeatureDetail = Schemas["FeatureDetail"];
export type FeatureState = Schemas["FeatureState"];
export type IssuedToken = Schemas["IssuedToken"];
export type LoginLink = Schemas["LoginLink"];
export type Me = Schemas["Me"];
export type Member = Schemas["Member"];
export type MemberDetail = Schemas["MemberDetail"];
export type Note = Schemas["Note"];
export type Observation = Schemas["Observation"];
export type ObservationOutcome = Schemas["ObservationOutcome"];
export type Skill = Schemas["Skill"];
export type SkillDetail = Schemas["SkillDetail"];
export type SkillVersion = Schemas["SkillVersion"];
export type Task = Schemas["Task"];
export type TaskDetail = Schemas["TaskDetail"];
export type Team = Schemas["Team"];
export type TeamDetail = Schemas["TeamDetail"];
export type Token = Schemas["Token"];

/** A refusal or failure from /v1, carrying the stable code programs branch on. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isUnauthenticated(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/** A random UUID, also where crypto.randomUUID is missing (plain http off localhost). */
export function newKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Every write carries an Idempotency-Key. The web app never retries a write, so each request
// gets its own key.
const idempotency: Middleware = {
  onRequest({ request }) {
    if (request.method !== "GET" && request.method !== "HEAD" && !request.headers.has("Idempotency-Key")) {
      request.headers.set("Idempotency-Key", newKey());
    }
    return request;
  },
};

/** The /v1 client. The browser's darkory_session cookie is the credential. */
export const api = createClient<paths>({
  baseUrl: window.location.origin,
  credentials: "include",
  // Looked up on every call rather than captured here, so tests can stub fetch.
  fetch: (request) => globalThis.fetch(request),
});
api.use(idempotency);

type Result<T> = { data?: T; error?: unknown; response: Response };

/** Waits for an openapi-fetch call and returns its data, or throws ApiError. */
export async function call<T>(pending: Promise<Result<T>>): Promise<T> {
  const { data, error, response } = await pending;
  if (!response.ok) throw toApiError(response, error);
  return data as T;
}

function toApiError(response: Response, error: unknown): ApiError {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const e = error as ErrorBody;
    return new ApiError(response.status, e.code, e.message, e.details);
  }
  const text = typeof error === "string" && error ? error : response.statusText;
  return new ApiError(response.status, response.status === 401 ? "unauthenticated" : "internal", text || `HTTP ${response.status}`);
}

/** Sends a file as the raw request body, as Evidence uploads take it. */
export function fileBody(file: File) {
  return {
    body: file as unknown as string,
    bodySerializer: (b: unknown) => b,
    headers: { "Content-Type": file.type || "application/octet-stream" },
  };
}

export function evidenceURL(id: string): string {
  return `/v1/evidence/${encodeURIComponent(id)}/content`;
}
