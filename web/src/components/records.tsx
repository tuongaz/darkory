import { useMutation } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";
import { evidenceURL, type Evidence, type Observation } from "../api/client";
import { Badge, Refusal, Time } from "./ui";
import { MemberName, SkillName } from "./work";

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Evidence with download links, and a form to attach a file. */
export function EvidenceSection({
  evidence,
  attach,
}: {
  evidence: Evidence[];
  attach: (file: File) => Promise<unknown>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const upload = useMutation({
    mutationFn: (f: File) => attach(f),
    onSuccess: () => {
      setFile(null);
      if (input.current) input.current.value = "";
    },
  });
  return (
    <section aria-labelledby="evidence-heading">
      <h2 id="evidence-heading">Evidence</h2>
      {evidence.length === 0 ? (
        <p className="muted">No Evidence attached.</p>
      ) : (
        <ul className="list">
          {evidence.map((e) => (
            <li key={e.id}>
              <div className="grow">
                <a href={evidenceURL(e.id)} download={e.filename}>
                  {e.filename}
                </a>
                <div className="meta">
                  {e.content_type} · {size(e.size)} · attached by <MemberName id={e.attached_by} />{" "}
                  <Time at={e.created_at} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        className="row"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (file) upload.mutate(file);
        }}
      >
        <label>
          Attach a file
          <input ref={input} type="file" onChange={(ev) => setFile(ev.target.files?.[0] ?? null)} />
        </label>
        <button type="submit" disabled={!file || upload.isPending}>
          Attach
        </button>
      </form>
      <Refusal error={upload.error} />
    </section>
  );
}

export function ObservationItems({ observations, showTask }: { observations: Observation[]; showTask?: (taskId: string) => ReactNode }) {
  return (
    <ul className="list">
      {observations.map((o) => (
        <li key={o.id}>
          <div className="grow">
            <div className="meta">
              <Badge tone={o.outcome === "worked" ? "worked" : "didnt-work"}>
                {o.outcome === "worked" ? "worked" : "didn't work"}
              </Badge>{" "}
              <MemberName id={o.author_id} />
              {o.skill_id && (
                <>
                  {" "}
                  under <SkillName id={o.skill_id} />
                </>
              )}{" "}
              <Time at={o.created_at} />
              {showTask && <> · {showTask(o.task_id)}</>}
              {o.reviewed_at && (
                <>
                  {" "}
                  · <Badge>reviewed</Badge>
                </>
              )}
            </div>
            <p className="body">{o.body}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
