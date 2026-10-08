// The record the tests of this folder share: /v1 answered from one list of Tasks, as the server
// would narrow it.
import type { Activity, Claim, MemberDetail, Task, TaskDetail } from "@/api/client";
import { parseFilter } from "@/components/filters/filterState";
import { matches } from "@/components/filters/taskAxes";
import { mockApi, refuse, type Handler } from "@/test/api";
import { ada, bob, builder, detail, engineer, signedIn, web } from "@/test/fixtures";

export const minutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

export function claim(taskId: string, holder: string, extra: Partial<Claim> = {}): Claim {
  return { id: `c-${taskId}`, task_id: taskId, holder_id: holder, session_id: "sess-1", started_at: minutes(-2), ...extra };
}

export function entry(seq: number, kind: Activity["kind"], subject: string, extra: Partial<Activity> = {}): Activity {
  const subjectType = kind.split(".")[0] as Activity["subject_type"];
  return { seq, at: minutes(-seq), kind, subject_type: subjectType, subject_id: subject, payload: {}, ...extra };
}

/** Each Member's record: ada and bob in WEB, builder in WEB with engineer. */
export function memberDetail(id: string): MemberDetail | undefined {
  const m = [ada, bob, builder].find((x) => x.id === id || x.name === id);
  if (!m) return undefined;
  return { member: m, projects: [web], skills: m.id === builder.id ? [engineer] : [], reports: [] };
}

/** The reads these screens make, answered from `tasks`. */
export function recordApi({
  tasks,
  takeable = [],
  details = {},
  activity = [],
  extra = {},
}: {
  tasks: Task[];
  takeable?: Task[];
  details?: Record<string, Partial<TaskDetail>>;
  activity?: Activity[];
  extra?: Record<string, Handler>;
}) {
  const routes: Record<string, Handler> = {
    ...signedIn(),
    "GET /v1/tasks/takeable": { items: takeable },
    "GET /v1/tasks": ({ query }) => {
      const pills = query.getAll("filter").flatMap((t) => parseFilter(t) ?? []);
      const items = tasks.filter(
        (t) =>
          (!query.get("aimed_at") || t.aimed_at_id === query.get("aimed_at")) &&
          (!query.get("holder") || t.claim?.holder_id === query.get("holder")) &&
          (!query.get("state") || t.state === query.get("state")) &&
          (!query.get("project") || t.project_id === web.id) &&
          matches(t, pills, { now: Date.now() }),
      );
      return { items };
    },
    "GET /v1/tasks/:task": ({ params }) => {
      const t = tasks.find((x) => x.key === params.task || x.id === params.task);
      return t ? detail(t, details[t.key]) : refuse(404, "not_found", `No Task ${params.task}`);
    },
    "GET /v1/members/:member": ({ params }) => memberDetail(params.member) ?? refuse(404, "not_found", "No Member"),
    "GET /v1/members/:member/sessions": { items: [] },
    "GET /v1/activity": ({ query }) => {
      const kinds = query.getAll("kind");
      const member = query.get("member");
      const ref = query.get("task");
      // `task` keeps a Task's entries and, for a Parent, its Subtasks', as /v1 does.
      const about = ref ? tasks.find((t) => t.key === ref || t.id === ref) : undefined;
      if (ref && !about) return refuse(404, "not_found", `No Task ${ref}`);
      const parentOf = (id: string) => tasks.find((t) => t.id === id)?.parent_id;
      const items = activity
        .filter((e) => kinds.length === 0 || kinds.includes(e.kind))
        .filter((e) => !member || e.actor_id === member || e.payload.holder_id === member)
        .filter((e) => !about || e.subject_id === about.id || parentOf(e.subject_id) === about.id)
        .sort((a, b) => a.seq - b.seq);
      return { items, last_seq: items.at(-1)?.seq ?? 0, first_seq: items[0]?.seq };
    },
    ...extra,
  };
  return mockApi(routes);
}
