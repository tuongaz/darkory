import createClient, { type Middleware } from "openapi-fetch";
import type { components, paths } from "./schema.gen";

/** Every schema of `/v1`, for the request bodies a write takes (`Schemas["FileTaskBody"]`). */
export type Schemas = components["schemas"];
export type Activity = Schemas["Activity"];
export type ActivityKind = Schemas["ActivityKind"];
export type ActivityPage = Schemas["ActivityPage"];
export type AgentSettings = Schemas["AgentSettings"];
export type Claim = Schemas["Claim"];
export type ClaimEnd = Schemas["ClaimEnd"];
export type Connector = Schemas["Connector"];
export type ErrorBody = Schemas["Error"];
export type ErrorCode = Schemas["ErrorCode"];
export type Evidence = Schemas["Evidence"];
/** A file the Organisation keeps (`/v1/files`); named so it does not shadow the DOM's File. */
export type FileRecord = Schemas["File"];
export type FilePurpose = Schemas["FilePurpose"];
export type Health = Schemas["Health"];
export type IssuedToken = Schemas["IssuedToken"];
export type Label = Schemas["Label"];
export type LoginLink = Schemas["LoginLink"];
export type Me = Schemas["Me"];
export type Member = Schemas["Member"];
export type MemberDetail = Schemas["MemberDetail"];
export type MemberKind = Schemas["MemberKind"];
export type NewWorkflow = Schemas["NewWorkflow"];
export type Note = Schemas["Note"];
export type Observation = Schemas["Observation"];
export type ObservationOutcome = Schemas["ObservationOutcome"];
export type Organisation = Schemas["Organisation"];
export type OrganisationBrief = Schemas["OrganisationBrief"];
export type Project = Schemas["Project"];
export type ProjectDetail = Schemas["ProjectDetail"];
export type ProposalState = Schemas["ProposalState"];
export type PullRequest = Schemas["PullRequest"];
export type RunnerSession = Schemas["RunnerSession"];
export type RunnerSessionState = Schemas["RunnerSessionState"];
export type Session = Schemas["Session"];
export type Skill = Schemas["Skill"];
export type SkillDetail = Schemas["SkillDetail"];
export type SkillProposal = Schemas["SkillProposal"];
export type SkillVersion = Schemas["SkillVersion"];
export type Step = Schemas["Step"];
export type StepFacts = Schemas["StepFacts"];
export type SubjectType = Schemas["SubjectType"];
export type SubtaskCounts = Schemas["SubtaskCounts"];
export type Taker = Schemas["Taker"];
export type Task = Schemas["Task"];
export type TaskBrief = Schemas["TaskBrief"];
export type TaskDetail = Schemas["TaskDetail"];
export type TaskKind = Schemas["TaskKind"];
export type TaskState = Schemas["TaskState"];
export type Token = Schemas["Token"];
export type View = Schemas["View"];
export type ViewEntity = Schemas["ViewEntity"];
export type Workflow = Schemas["Workflow"];
export type Workflows = Schemas["Workflows"];
export type WorkflowStep = Schemas["WorkflowStep"];
export type Workspace = Schemas["Workspace"];
export type WorkspaceMode = Schemas["WorkspaceMode"];

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

  /**
   * The names `details` lists under `field`, as `/v1` gives them for programs to choose from:
   * `outcomes` (the Connectors out of the Task's Step) on `no_connector` and `use_advance`,
   * `proposals` (proposal ids) on `proposal_stale`. Empty when the refusal carries none.
   */
  detailList(field: "outcomes" | "proposals"): string[] {
    const v = this.details?.[field];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  }
}

export function isUnauthenticated(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/** Whether `err` is a refusal from /v1 with one of `codes`. */
export function isRefusal(err: unknown, ...codes: ErrorCode[]): err is ApiError {
  return err instanceof ApiError && (codes.length === 0 || (codes as string[]).includes(err.code));
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

/** Where a file's bytes are served; an image there is inline, so an <img> shows it. */
export function fileURL(id: string): string {
  return `/v1/files/${encodeURIComponent(id)}/content`;
}

export function evidenceURL(id: string): string {
  return `/v1/evidence/${encodeURIComponent(id)}/content`;
}
