package cli

import (
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
	{path: "release", args: "<task> [--note text]", short: "give up your Claim; the Task needs the same Skill", run: cmdRelease},
	{path: "handover", args: "<task> --skill skill [--note text]", short: "end your Claim and set the Skill the Task needs next", run: cmdHandover},
	{path: "complete", args: "<task> [--note text]", short: "complete a Task you hold", run: cmdComplete},
	{path: "drop", args: "<task> [--reason text]", short: "drop a Task (Feature owner)", run: cmdDrop},
	{path: "take-back", args: "<task> [--reason text]", short: "end another Member's Claim (Reporting line or Feature owner)", run: cmdTakeBack},
	{path: "note", args: "<task> <text|->", short: "add a Note to a Task's running log", run: cmdNote},
	{path: "observe", args: "<task> --worked <text|-> | --didnt-work <text|->", short: "record an Observation", run: cmdObserve},
	{path: "attach", args: "<task|feature> <file> [--type mime] [--name filename] [--feature]", short: "attach Evidence", run: cmdAttach},
	{path: "evidence get", args: "<id> [-o file|-]", short: "show an Evidence record, or download its file", run: cmdEvidenceGet},
	{path: "file", args: "--title t (--skill s | --aim member) (--feature f | --blocks task) [--body text|-]", short: "file a Task; with --blocks, a question that blocks a Task", run: cmdFile},
	{path: "block", args: "<task> --by <task>", short: "let a Task block another", run: cmdBlock},
	{path: "unblock", args: "<task> --by <task>", short: "stop a Task blocking another", run: cmdUnblock},
	{path: "show", args: "<task>", short: "show a Task with its Claims, Notes, Evidence and Observations", run: cmdShow},
	{path: "tasks", args: "[--feature f] [--team t] [--state s] [--skill s] [--aimed-at m] [--holder m | --mine]", short: "list Tasks", run: cmdTasks},
	{path: "propose", args: "<task> --skill skill --base n --file path|-", short: "propose a new version of a company Skill", run: cmdPropose},
	{path: "activity", args: "[--after n] [--limit n] [--follow]", short: "read Activity, or follow it as it happens", run: cmdActivity, long: true},
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

func cmdHandover(c *call) error {
	skill := c.fs.String("skill", "", "the Skill the Task needs next")
	note := c.noteFlag()
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	if *skill == "" {
		return usagef("needs --skill")
	}
	n, err := c.optText(*note)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.HandoverTaskWithResponse(c.ctx, args[0], &client.HandoverTaskParams{}, client.HandoverTaskBody{Skill: *skill, Note: n})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.done(w, "Handed over", *res.JSON200) })
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
	toFeature := c.fs.Bool("feature", false, "attach to the Feature without first asking whether the key names a Task")
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
	ev, body, err := conn.Attach(c.ctx, args[0], filename, ct, content, *toFeature)
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
		fmt.Fprintf(c.env.Stdout, "Saved %d bytes to %s.\n", n, *out)
	}
	return nil
}

func cmdFile(c *call) error {
	feature := c.fs.String("feature", "", "the Feature the Task belongs to")
	skill := c.fs.String("skill", "", "the Skill the Task needs")
	aim := c.fs.String("aim", "", "the Member the Task is aimed at by name")
	blocks := c.fs.String("blocks", "", "a Task the new one blocks: a question or Escalation, filed on that Task's Feature")
	title := c.fs.String("title", "", "the Task's title")
	body := c.fs.String("body", "", "the Task's description (- reads standard input)")
	if _, err := c.args(0, 0); err != nil {
		return err
	}
	switch {
	case *title == "":
		return usagef("needs --title")
	case (*skill == "") == (*aim == ""):
		return usagef("give --skill or --aim, not both")
	case *feature == "" && *blocks == "":
		return usagef("needs --feature or --blocks")
	}
	desc, err := c.optText(*body)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.FileTaskWithResponse(c.ctx, &client.FileTaskParams{}, client.FileTaskBody{
		Feature: opt(*feature), Title: *title, Description: desc, Skill: opt(*skill), AimedAt: opt(*aim), Blocks: opt(*blocks)})
	if err := check(res, err, http.StatusCreated); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.done(w, "Filed", res.JSON201.Task) })
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
	feature := c.fs.String("feature", "", "only this Feature's Tasks")
	team := c.fs.String("team", "", "only this Team's Tasks")
	state := c.fs.String("state", "", "only Tasks in this state: open, done or dropped")
	skill := c.fs.String("skill", "", "only Tasks that need this Skill now")
	aimed := c.fs.String("aimed-at", "", "only Tasks aimed at this Member")
	holder := c.fs.String("holder", "", "only Tasks this Member holds")
	mine := c.fs.Bool("mine", false, "only Tasks you hold")
	limit := c.fs.Int("limit", 0, "at most this many Tasks (default 100)")
	cursor := c.fs.String("cursor", "", "the next page, from a previous list")
	if _, err := c.args(0, 0); err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	params := &client.ListTasksParams{Feature: opt(*feature), Team: opt(*team), Skill: opt(*skill), AimedAt: opt(*aimed),
		Holder: opt(*holder), Cursor: opt(*cursor)}
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
		fmt.Fprintf(w, "Proposed a new version of %s against v%d (%s). Hand %s over to skill-review for review.\n",
			c.skill(p.SkillID), p.BasedOnVersion, p.State, args[0])
	})
}
