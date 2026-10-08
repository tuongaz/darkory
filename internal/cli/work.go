package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/cli/remote"
)

var workCommands = []command{
	{path: "prime", args: "[--rules-only]", short: "print a fresh Session id to eval, and the working rules", run: cmdPrime},
	{path: "next", args: "[--wait 30s] [--timeout d] [--model label]", short: "wait for a takeable Task and claim it", run: cmdNext},
	{path: "takeable", args: "[--limit n]", short: "list the Tasks you can take now, in the order next offers them", run: cmdTakeable},
	{path: "claim", args: "<task> [--timeout d] [--model label]", short: "claim a Task", run: cmdClaim},
	{path: "heartbeat", args: "<task>", short: "tell Darkory you are still working a Task", run: cmdHeartbeat},
	{path: "heartbeat run", args: "[--background] [--watch-pid pid]", short: "heartbeat this Session's Claims until stopped", run: cmdHeartbeatRun, long: true},
	{path: "heartbeat stop", args: "", short: "stop this Session's background heartbeat", run: cmdHeartbeatStop},
	{path: "release", args: "<task> [--note text]", short: "give up your Claim; the Task stays at its Step", run: cmdRelease},
	{path: "advance", args: "<task> [outcome] [--note text]", short: "end your work on a Task along one of its Step's outcomes, to the next Step or into Done", run: cmdAdvance},
	{path: "move", args: "<task> <step> [--note text]", short: "move a Task to a Step of its Workflow by hand (a held one: its Owner or the holder's Reporting line)", run: cmdMove},
	{path: "complete", args: "<task> [--note text]", short: "complete a Task you hold whose Step has one way into Done, or a Parent you own", run: cmdComplete},
	{path: "drop", args: "<task> [--reason text]", short: "drop a Task, and a Parent's open Subtasks (Owner)", run: cmdDrop},
	{path: "take-back", args: "<task> [--reason text]", short: "end another Member's Claim (Reporting line or Owner)", run: cmdTakeBack},
	{path: "rank", args: "<task> <position>", short: "move a Task in its Project's Rank (1 is first)", run: cmdRank},
	{path: "owner", args: "<task> <member>", short: "pass a Task's ownership, with its Subtasks', to another Member", run: cmdOwner},
	{path: "note", args: "<task> <text|->", short: "add a Note to a Task's running log", run: cmdNote},
	{path: "observe", args: "<task> --worked <text|-> | --didnt-work <text|->", short: "record an Observation", run: cmdObserve},
	{path: "observations", args: "<task> [--all]", short: "list the Observations on a Task and its Subtasks not yet reviewed", run: cmdObservations},
	{path: "attach", args: "<task> <file> [--type mime] [--name filename]", short: "attach Evidence", run: cmdAttach},
	{path: "evidence get", args: "<id> [-o file|-]", short: "show an Evidence record, or download its file", run: cmdEvidenceGet},
	{path: "file", args: "--title t (--project p | --parent task | --blocks task --aim member) [--step s] [--breakdown] [--label l]… [--owner m] [--workspace ws]… [--body text|-]", short: "file a Task; with --parent, a Subtask; with --blocks, a question that blocks a Task", run: cmdFile},
	{path: "block", args: "<task> --by <task>", short: "let a Task block another", run: cmdBlock},
	{path: "unblock", args: "<task> --by <task>", short: "stop a Task blocking another", run: cmdUnblock},
	{path: "show", args: "<task>", short: "show a Task with its Step and outcomes, Subtasks, Claims, Notes, Evidence and Observations", run: cmdShow},
	{path: "tasks", args: "[--project p] [--parent task] [--state s] [--step s] [--aimed-at m] [--holder m | --mine] [--filter field:op:values]...", short: "list Tasks", run: cmdTasks},
	{path: "propose", args: "<task> --skill skill --base n --file path|-", short: "propose a new version of a company Skill", run: cmdPropose},
	{path: "proposal show", args: "<task|proposal id>", short: "show the Skill proposals written on a Task, or one by id", run: cmdProposalShow},
	{path: "activity", args: "[--after n | --before n | --all] [--limit n] [--member m] [--kind k,…] [--project p] [--follow]", short: "read Activity (the latest page by default), or follow it as it is written", run: cmdActivity, long: true},
}

// maxWait is the longest one `next` request waits; longer waits are made of several.
const maxWait = 60

func cmdNext(c *call) error {
	wait := c.fs.String("wait", "30s", "how long to wait for a takeable Task; 0 returns at once")
	timeoutFlag := c.timeoutFlag()
	model := c.fs.String("model", "", "the AI model you run on, recorded on the Claim")
	if _, err := c.args(0, 0); err != nil {
		return err
	}
	w, err := seconds(*wait)
	if err != nil {
		return usagef("--wait: %v", err)
	}
	timeout, err := claimTimeout(*timeoutFlag)
	if err != nil {
		return err
	}
	conn, err := c.dial(needs(timeout))
	if err != nil {
		return err
	}
	deadline := time.Now().Add(time.Duration(w) * time.Second)
	for {
		left := min(int(time.Until(deadline).Round(time.Second).Seconds()), maxWait)
		body := client.NextTaskBody{WaitSeconds: ptr(max(left, 0)), HeartbeatTimeoutSeconds: timeout, ModelLabel: opt(*model)}
		res, err := conn.NextTaskWithResponse(c.ctx, &client.NextTaskParams{}, body)
		if err := check(res, err, http.StatusOK, http.StatusNoContent); err != nil {
			return err
		}
		if res.StatusCode() == http.StatusOK {
			return c.show(res.Body, func(w io.Writer) { c.printClaimed(w, *res.JSON200) })
		}
		if !time.Now().Before(deadline) {
			return nothing{fmt.Sprintf("No Task became takeable within %s.", time.Duration(w)*time.Second)}
		}
	}
}

// printClaimed prints a Task just claimed, with how to keep the Claim alive.
func (c *call) printClaimed(w io.Writer, d client.TaskDetail) {
	c.printTaskDetail(w, d)
	if cl := d.Task.Claim; cl != nil && cl.HeartbeatTimeoutSeconds != nil {
		fmt.Fprintf(w, "\nClaimed %s for this Session. Heartbeat at least every %ds (darkory heartbeat %s), or run darkory heartbeat run --background.\n",
			d.Task.Key, max(*cl.HeartbeatTimeoutSeconds/3, 1), d.Task.Key)
	} else {
		fmt.Fprintf(w, "\nClaimed %s; the Claim has no heartbeat timeout and is bound to you, not this Session.\n", d.Task.Key)
	}
}

func cmdTakeable(c *call) error {
	limit := c.fs.Int("limit", 0, "at most this many Tasks (default 100)")
	if _, err := c.args(0, 0); err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	params := &client.ListTakeableTasksParams{}
	if *limit > 0 {
		params.Limit = limit
	}
	res, err := conn.ListTakeableTasksWithResponse(c.ctx, params)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printTasks(w, res.JSON200.Items, nil) })
}

func cmdClaim(c *call) error {
	timeoutFlag := c.timeoutFlag()
	model := c.fs.String("model", "", "the AI model you run on, recorded on the Claim")
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	timeout, err := claimTimeout(*timeoutFlag)
	if err != nil {
		return err
	}
	conn, err := c.dial(needs(timeout))
	if err != nil {
		return err
	}
	res, err := conn.ClaimTaskWithResponse(c.ctx, args[0], &client.ClaimTaskParams{},
		client.ClaimTaskBody{HeartbeatTimeoutSeconds: timeout, ModelLabel: opt(*model)})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printClaimed(w, *res.JSON200) })
}

func cmdHeartbeat(c *call) error {
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	conn, err := c.dial(lasting)
	if err != nil {
		return err
	}
	res, err := conn.HeartbeatWithResponse(c.ctx, args[0], &client.HeartbeatParams{})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	reply := *res.JSON200
	if err := c.show(res.Body, func(w io.Writer) {
		if reply.Status == client.HeartbeatStatusOk {
			if reply.ExpiresAt != nil {
				fmt.Fprintf(w, "ok: your Claim on %s now expires at %s\n", args[0], stamp(*reply.ExpiresAt))
			} else {
				fmt.Fprintf(w, "ok: your Claim on %s has no heartbeat timeout\n", args[0])
			}
		}
	}); err != nil {
		return err
	}
	if reply.Status != client.HeartbeatStatusOk {
		return refusal{remote.Notice{TaskKey: args[0], Status: reply.Status}.String()}
	}
	return nil
}

// noteFlag registers --note, a Note added in the same write.
func (c *call) noteFlag() *string {
	return c.fs.String("note", "", "a Note added to the Task in the same write (- reads standard input)")
}

func (c *call) optText(s string) (*string, error) {
	if s == "" {
		return nil, nil
	}
	t, err := c.text(s)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func cmdRelease(c *call) error {
	note := c.noteFlag()
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	n, err := c.optText(*note)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.ReleaseTaskWithResponse(c.ctx, args[0], &client.ReleaseTaskParams{}, client.ReleaseTaskBody{Note: n})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.done(w, "Released", *res.JSON200) })
}

// done prints what a write did to a Task.
func (c *call) done(w io.Writer, what string, t client.Task) {
	fmt.Fprintf(w, "%s %s.\n", what, t.Key)
	c.printTaskLine(w, t)
}

func cmdAdvance(c *call) error {
	note := c.noteFlag()
	args, err := c.args(1, 2)
	if err != nil {
		return err
	}
	n, err := c.optText(*note)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	body := client.AdvanceTaskBody{Note: n}
	if len(args) == 2 {
		body.Outcome = &args[1]
	}
	res, err := conn.AdvanceTaskWithResponse(c.ctx, args[0], &client.AdvanceTaskParams{}, body)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) {
		t := *res.JSON200
		if t.State == client.TaskStateDone {
			c.done(w, "Completed", t)
			return
		}
		c.done(w, "Advanced", t)
	})
}

func cmdMove(c *call) error {
	note := c.noteFlag()
	args, err := c.args(2, 2)
	if err != nil {
		return err
	}
	n, err := c.optText(*note)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.MoveTaskWithResponse(c.ctx, args[0], &client.MoveTaskParams{}, client.MoveTaskBody{Step: args[1], Note: n})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.done(w, "Moved", *res.JSON200) })
}

func cmdRank(c *call) error {
	args, err := c.args(2, 2)
	if err != nil {
		return err
	}
	pos, err := strconv.ParseInt(args[1], 10, 64)
	if err != nil || pos < 1 {
		return usagef("the position is a number from 1")
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.RankTaskWithResponse(c.ctx, args[0], &client.RankTaskParams{}, client.RankTaskBody{Position: pos})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.done(w, fmt.Sprintf("Ranked #%d:", deref(res.JSON200.Rank)), *res.JSON200) })
}

func cmdOwner(c *call) error {
	args, err := c.args(2, 2)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.PassOwnershipWithResponse(c.ctx, args[0], &client.PassOwnershipParams{}, client.PassOwnershipBody{Owner: args[1]})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) {
		c.done(w, "Passed ownership of", *res.JSON200)
		fmt.Fprintf(w, "Owner: %s\n", c.member(res.JSON200.OwnerID))
	})
}

func cmdObservations(c *call) error {
	all := c.fs.Bool("all", false, "every Observation, reviewed by a Retrospective or not")
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	// The contract's reviewed=true means every Observation; leaving it out, only unreviewed ones.
	params := &client.ListTaskObservationsParams{}
	if *all {
		params.Reviewed = ptr(true)
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.ListTaskObservationsWithResponse(c.ctx, args[0], params)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) {
		if len(res.JSON200.Items) == 0 {
			fmt.Fprintln(w, "No Observations.")
		}
		for _, o := range res.JSON200.Items {
			c.printObservation(w, o)
		}
	})
}

func cmdComplete(c *call) error {
	note := c.noteFlag()
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	n, err := c.optText(*note)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.CompleteTaskWithResponse(c.ctx, args[0], &client.CompleteTaskParams{}, client.CompleteTaskBody{Note: n})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.done(w, "Completed", *res.JSON200) })
}

func cmdDrop(c *call) error {
	reason := c.fs.String("reason", "", "why the Task will not be done")
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.DropTaskWithResponse(c.ctx, args[0], &client.DropTaskParams{}, client.DropTaskBody{Reason: opt(*reason)})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.done(w, "Dropped", *res.JSON200) })
}

func cmdTakeBack(c *call) error {
	reason := c.fs.String("reason", "", "why the Claim is taken back")
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.TakeBackTaskWithResponse(c.ctx, args[0], &client.TakeBackTaskParams{}, client.TakeBackTaskBody{Reason: opt(*reason)})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.done(w, "Took back", *res.JSON200) })
}

func cmdNote(c *call) error {
	args, err := c.args(2, -1)
	if err != nil {
		return err
	}
	body, err := c.text(strings.Join(args[1:], " "))
	if err != nil {
		return err
	}
	if strings.TrimSpace(body) == "" {
		return usagef("the Note is empty")
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.AddNoteWithResponse(c.ctx, args[0], &client.AddNoteParams{}, client.AddNoteBody{Body: body})
	if err := check(res, err, http.StatusCreated); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { fmt.Fprintf(w, "Noted on %s.\n", args[0]) })
}

func cmdObserve(c *call) error {
	worked := c.fs.String("worked", "", "what worked (- reads standard input)")
	didnt := c.fs.String("didnt-work", "", "what didn't work (- reads standard input)")
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	var body client.ObserveBody
	switch {
	case *worked != "" && *didnt != "":
		return usagef("give --worked or --didnt-work, not both")
	case *worked != "":
		body.Outcome, body.Body = client.Worked, *worked
	case *didnt != "":
		body.Outcome, body.Body = client.DidntWork, *didnt
	default:
		return usagef("needs --worked or --didnt-work")
	}
	if body.Body, err = c.text(body.Body); err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.ObserveWithResponse(c.ctx, args[0], &client.ObserveParams{}, body)
	if err := check(res, err, http.StatusCreated); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { fmt.Fprintf(w, "Observed on %s (%s).\n", args[0], body.Outcome) })
}

func cmdAttach(c *call) error {
	typ := c.fs.String("type", "", "the file's content type (default: from its extension, else its content)")
	name := c.fs.String("name", "", "the name to show and download it as (default: the file's own)")
	args, err := c.args(2, 2)
	if err != nil {
		return err
	}
	content, err := os.ReadFile(args[1])
	if err != nil {
		return err
	}
	filename := *name
	if filename == "" {
		filename = filepath.Base(args[1])
	}
	ct := *typ
	if ct == "" {
		ct = remote.ContentType(filename, content)
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	// Show what is about to be sent, so a person sees which file leaves the machine.
	shown, err := filepath.Abs(args[1])
	if err != nil {
		return err
	}
	if real, err := filepath.EvalSymlinks(shown); err == nil && real != shown {
		shown += " -> " + real
	}
	fmt.Fprintf(c.errOut(), "Attaching %s (%d bytes, %s) as %s.\n", shown, len(content), ct, filename)
	ev, body, err := conn.Attach(c.ctx, args[0], filename, ct, content)
	if err != nil {
		return err
	}
	return c.show(body, func(w io.Writer) {
		fmt.Fprintf(w, "Attached %s to %s.\n", filename, args[0])
		c.printEvidence(w, ev)
	})
}

func cmdEvidenceGet(c *call) error {
	out := c.fs.String("o", "", "download the file here; - for standard output")
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	if *out == "" {
		res, err := conn.GetEvidenceWithResponse(c.ctx, args[0])
		if err := check(res, err, http.StatusOK); err != nil {
			return err
		}
		return c.show(res.Body, func(w io.Writer) { c.printEvidence(w, *res.JSON200) })
	}
	res, err := conn.ClientInterface.DownloadEvidence(c.ctx, args[0])
	if err != nil {
		return check(nil, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(res.Body)
		return remote.ErrorFrom(res.StatusCode, b)
	}
	if *out == "-" {
		_, err = io.Copy(c.env.Stdout, res.Body)
		return err
	}
	f, err := os.Create(*out)
	if err != nil {
		return err
	}
	n, err := io.Copy(f, res.Body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if !c.g.json {
		fmt.Fprintf(c.out(), "Saved %d bytes to %s.\n", n, *out)
	}
	return nil
}

func cmdFile(c *call) error {
	project := c.fs.String("project", "", "the Project the Task belongs to")
	parent := c.fs.String("parent", "", "the Task the new one is a Subtask of; it takes the Parent's Project and Owner (if you hold the Parent, filing ends your Claim)")
	blocks := c.fs.String("blocks", "", "a Task the new one blocks: a question or Escalation, filed beside that Task, under its Parent if it has one")
	aim := c.fs.String("aim", "", "the Member the Task is aimed at by name, who takes it whatever its Step")
	title := c.fs.String("title", "", "the Task's title")
	body := c.fs.String("body", "", "the Task's description (- reads standard input)")
	step := c.fs.String("step", "", "the Step it starts at, by name or id, such as Backlog (default: the Project's first work Step)")
	breakdown := c.fs.Bool("breakdown", false, "file it with Break down: a Breakdown Subtask at the Step carrying the breakdown Skill files its other Subtasks")
	var labels strs
	c.fs.Var(&labels, "label", "a Label it carries, by name or id; give it once per Label, or name several with commas")
	owner := c.fs.String("owner", "", "its Owner (default: you; a Subtask's is its Parent's)")
	retro := c.fs.String("from-retro", "", "the Retrospective filing this Task")
	note := c.noteFlag()
	var auto, acceptance optBool
	c.fs.Var(&auto, "auto-complete", "it completes itself when its last Subtask ends Done (default: the Project's)")
	c.fs.Var(&acceptance, "acceptance", "it has an Acceptance before it is done, where the Workflow has the Step (default: the Project's)")
	var workspaces strs
	c.fs.Var(&workspaces, "workspace", "a Workspace the Task names, where a session works it; give it once per Workspace (default: its Parent's, else its Project's)")
	noWorkspace := c.fs.Bool("no-workspace", false, "name no Workspace, though its Parent or Project names one")
	if _, err := c.args(0, 0); err != nil {
		return err
	}
	if *noWorkspace && workspaces.set {
		return usagef("give --workspace or --no-workspace, not both")
	}
	switch {
	case *title == "":
		return usagef("needs --title")
	case *project == "" && *parent == "" && *blocks == "":
		return usagef("needs --project, --parent or --blocks")
	}
	desc, err := c.optText(*body)
	if err != nil {
		return err
	}
	n, err := c.optText(*note)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	req := client.FileTaskBody{Project: opt(*project), Parent: opt(*parent), Blocks: opt(*blocks), Aim: opt(*aim), Title: *title,
		Description: desc, Step: opt(*step), Owner: opt(*owner), FromRetrospective: opt(*retro), Note: n,
		AutoComplete: auto.v, Acceptance: acceptance.v}
	if *breakdown {
		req.Breakdown = breakdown
	}
	if labels.set {
		var ls []string
		for _, l := range labels.v {
			for _, one := range strings.Split(l, ",") {
				if one = strings.TrimSpace(one); one != "" {
					ls = append(ls, one)
				}
			}
		}
		req.Labels = &ls
	}
	switch {
	case workspaces.set:
		req.Workspaces = &workspaces.v
	case *noWorkspace:
		req.Workspaces = &[]string{}
	}
	res, err := conn.FileTaskWithResponse(c.ctx, &client.FileTaskParams{}, req)
	if err := check(res, err, http.StatusCreated); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) {
		d := res.JSON201
		c.done(w, "Filed", d.Task)
		for _, st := range d.Subtasks {
			fmt.Fprint(w, "  ")
			c.printTaskLine(w, st)
		}
	})
}

func cmdBlock(c *call) error {
	by := c.fs.String("by", "", "the Task that blocks it")
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	if *by == "" {
		return usagef("needs --by")
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.AddBlockerWithResponse(c.ctx, args[0], *by, &client.AddBlockerParams{})
	if err := check(res, err, http.StatusNoContent); err != nil {
		return err
	}
	return c.show(nil, func(w io.Writer) { fmt.Fprintf(w, "%s is blocked by %s.\n", args[0], *by) })
}

func cmdUnblock(c *call) error {
	by := c.fs.String("by", "", "the Task that blocks it")
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	if *by == "" {
		return usagef("needs --by")
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.RemoveBlockerWithResponse(c.ctx, args[0], *by, &client.RemoveBlockerParams{})
	if err := check(res, err, http.StatusNoContent); err != nil {
		return err
	}
	return c.show(nil, func(w io.Writer) { fmt.Fprintf(w, "%s is no longer blocked by %s.\n", args[0], *by) })
}

func cmdShow(c *call) error {
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.GetTaskWithResponse(c.ctx, args[0])
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printTaskDetail(w, *res.JSON200) })
}

func cmdTasks(c *call) error {
	project := c.fs.String("project", "", "only this Project's Tasks")
	parent := c.fs.String("parent", "", "only this Parent's Subtasks")
	state := c.fs.String("state", "", "only Tasks in this state: open, done or dropped")
	step := c.fs.String("step", "", "only Tasks at this Step: its id, or its name with --project")
	aimed := c.fs.String("aimed-at", "", "only Tasks aimed at this Member")
	holder := c.fs.String("holder", "", "only Tasks this Member holds")
	mine := c.fs.Bool("mine", false, "only Tasks you hold")
	var filters strs
	c.fs.Var(&filters, "filter", "only Tasks matching field:op:values, such as holder:is:none, skill:is:<id> or filed_at:last:7d (ids, not names); give it once per filter")
	limit := c.fs.Int("limit", 0, "at most this many Tasks (default 100)")
	cursor := c.fs.String("cursor", "", "the next page, from a previous list")
	if _, err := c.args(0, 0); err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	params := &client.ListTasksParams{Project: opt(*project), Parent: opt(*parent), Step: opt(*step), AimedAt: opt(*aimed),
		Holder: opt(*holder), Cursor: opt(*cursor)}
	if filters.set {
		params.Filter = &filters.v
	}
	if *state != "" {
		params.State = ptr(client.TaskState(*state))
	}
	if *limit > 0 {
		params.Limit = limit
	}
	if *mine {
		id, err := c.me()
		if err != nil {
			return err
		}
		params.Holder = &id
	}
	res, err := conn.ListTasksWithResponse(c.ctx, params)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printTasks(w, res.JSON200.Items, res.JSON200.NextCursor) })
}

func cmdPropose(c *call) error {
	skill := c.fs.String("skill", "", "the company Skill")
	base := c.fs.String("base", "", "the version the proposal is written against, which must be current")
	file := c.fs.String("file", "", "the proposed text; - reads standard input")
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	if *skill == "" || *base == "" || *file == "" {
		return usagef("needs --skill, --base and --file")
	}
	n, err := strconv.ParseInt(*base, 10, 64)
	if err != nil || n < 1 {
		return usagef("--base is a version number")
	}
	var text []byte
	if *file == "-" {
		text, err = io.ReadAll(c.env.Stdin)
	} else {
		text, err = os.ReadFile(*file)
	}
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.ProposeSkillVersionWithResponse(c.ctx, args[0], &client.ProposeSkillVersionParams{},
		client.ProposeSkillVersionBody{Skill: *skill, BasedOnVersion: n, Body: string(text)})
	if err := check(res, err, http.StatusCreated); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) {
		p := res.JSON201
		fmt.Fprintf(w, "Proposed a new version of %s against v%d (%s). Advance %s to the Step carrying skill-review for review (darkory show %s lists the outcomes).\n",
			c.skill(p.SkillID), p.BasedOnVersion, p.State, one(args[0]), one(args[0]))
	})
}

func cmdProposalShow(c *call) error {
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	// A Task carries its latest proposal for each Skill; anything else is taken as a proposal's id.
	res, err := conn.GetTaskWithResponse(c.ctx, args[0])
	err = check(res, err, http.StatusOK)
	switch {
	case err == nil:
		ps := res.JSON200.Proposals
		if len(ps) == 0 {
			return fmt.Errorf("no Skill proposal has been written on %s", res.JSON200.Task.Key)
		}
		var raw struct {
			Proposals json.RawMessage `json:"proposals"`
		}
		if err := json.Unmarshal(res.Body, &raw); err != nil {
			return err
		}
		return c.show(raw.Proposals, func(w io.Writer) {
			for i, p := range ps {
				if i > 0 {
					fmt.Fprintln(w)
				}
				c.printProposal(w, p, res.JSON200.Task.Key)
			}
		})
	case remote.CodeOf(err) != client.ErrorCodeNotFound:
		return err
	}
	pres, err := conn.GetSkillProposalWithResponse(c.ctx, args[0])
	if err := check(pres, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(pres.Body, func(w io.Writer) { c.printProposal(w, *pres.JSON200, "") })
}
