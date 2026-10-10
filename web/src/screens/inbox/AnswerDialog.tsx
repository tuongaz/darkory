import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { api, call, type Task } from "@/api/client";
import { useTask } from "@/api/queries";
import { useNow } from "@/clock";
import { FormDialog } from "@/components/FormDialog";
import { Key } from "@/components/Key";
import { Markdown } from "@/components/Markdown";
import { Refusal } from "@/components/Refusal";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentMe } from "@/me";
import { taskPath, useMemberName } from "@/screens/task/format";
import { liveClaim } from "@/work";

/**
 * Answers a question aimed at me in one act: claims it, then completes it with the answer as its
 * Note. A refusal stops the chain and the dialog stays open with it; when the claim landed and the
 * complete was refused, or I held it already, the dialog says I hold the question, and a second
 * Answer only completes. It stays mounted, so it closes with its animation.
 */
export function AnswerDialog({ task, open, onOpenChange }: { task: Task; open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const now = useNow();
  const me = useCurrentMe().member.id;
  const name = useMemberName();
  const [answer, setAnswer] = useState("");
  // The claim landed in this dialog, or I held the question already.
  const [claimed, setClaimed] = useState(false);
  // Each opening is a round: it starts with no answer, and shows only its own refusal. The
  // question's record is read once the dialog has opened, and kept while it closes.
  const [round, setRound] = useState(open ? 1 : 0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setRound(round + 1);
      setAnswer("");
      setClaimed(false);
    }
  }
  const detail = useTask(round > 0 ? task.key : undefined).data;
  const question = detail?.task ?? task;
  const blocks = detail?.blocking[0];
  const holding = claimed || liveClaim(question, now)?.holder_id === me;

  // The round it was sent in is its variable.
  const send = useMutation<unknown, Error, number>({
    mutationFn: async () => {
      const ref = { params: { path: { task: task.key } } };
      if (!holding) {
        await call(api.POST("/v1/tasks/{task}/claim", { ...ref, body: {} }));
        setClaimed(true);
      }
      return call(api.POST("/v1/tasks/{task}/complete", { ...ref, body: { note: answer.trim() } }));
    },
    onSuccess: () => {
      toast.success(`${task.key} answered`);
      onOpenChange(false);
    },
    onSettled: () => {
      for (const root of ["tasks", "task", "takeable", "workflow"]) void qc.invalidateQueries({ queryKey: [root] });
    },
  });

  const refused = send.isError && send.variables === round;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Answer ${task.key}`}
      hint={`Answers and ends ${task.key}`}
      submitLabel="Answer"
      onSubmit={() => send.mutate(round)}
      pending={send.isPending}
      submitDisabled={answer.trim() === ""}
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="text-sm break-words text-foreground">{question.title}</p>
        {question.description.trim() !== "" && (
          <div className="max-h-60 overflow-y-auto text-sm">
            <Markdown text={question.description} />
          </div>
        )}
        <p className="truncate text-xs text-muted-foreground">
          From {name(question.filed_by ?? question.owner_id)}
          {blocks && (
            <>
              {" · blocks "}
              <Key>{blocks.key}</Key> {blocks.title}
            </>
          )}
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <Label htmlFor="answer-text" className="text-[12.5px] font-medium">
          Your answer
        </Label>
        <Textarea id="answer-text" value={answer} onChange={(e) => setAnswer(e.target.value)} className="min-h-24" autoFocus />
        <Refusal error={refused && send.error} />
        {refused && holding && (
          <p className="text-xs text-muted-foreground">
            You hold {task.key}; complete it from{" "}
            <Link to={taskPath(task.key)} className="text-foreground underline underline-offset-2">
              its page
            </Link>
          </p>
        )}
      </div>
    </FormDialog>
  );
}
