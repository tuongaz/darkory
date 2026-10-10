package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/cli/remote"
)

// Human output goes through a cleanWriter, which escapes terminal controls and bidi overrides in
// whatever other Members wrote (remote.Clean). Fields printed on one line — titles, names, keys,
// filenames — also pass through one, so that a newline in them cannot pass for another line.
var one = remote.CleanLine

// cleanWriter writes text with terminal controls and bidi overrides escaped. Each Write is one
// whole formatted string, so no character is split between writes.
type cleanWriter struct{ w io.Writer }

func (cw cleanWriter) Write(p []byte) (int, error) {
	if _, err := io.WriteString(cw.w, remote.Clean(string(p))); err != nil {
		return 0, err
	}
	return len(p), nil
}

func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339) }

func deref[T any](p *T) T {
	var z T
	if p == nil {
		return z
	}
	return *p
}

// whereOf says where a Task is: at a Step, with the Member it is aimed at, or, for a Parent,
// how far its Subtasks have got.
func (c *call) whereOf(t client.Task) string {
	switch {
	case t.SubtaskCounts != nil:
		n := t.SubtaskCounts
		return fmt.Sprintf("parent %d/%d", n.Done, n.Open+n.Done+n.Dropped)
	case t.AimedAtID != nil:
		return "@" + c.member(*t.AimedAtID)
	case t.StepID != nil:
		return c.step(t.ProjectID, *t.StepID)
	}
	return "-"
}

// skillOf names the Skill that takes a Task at its Step; "-" for none.
func (c *call) skillOf(t client.Task) string {
	if t.SkillID != nil {
		return c.skill(*t.SkillID)
	}
	return "-"
}

// labelsOf names the Labels a Task carries.
func (c *call) labelNames(t client.Task) string {
	return names(deref(t.Labels), func(id string) string { return c.label(t.ProjectID, id) })
}

func stateOf(t client.Task) string {
	s := one(string(t.State))
	if t.Blocked && t.State == client.TaskStateOpen {
		s += ",blocked"
	}
	return s
}

// claimOf says who holds a Task and until when.
func (c *call) claimOf(cl *client.Claim) string {
	if cl == nil {
		return ""
	}
	s := "held by " + c.member(cl.HolderID)
	if cl.ExpiresAt != nil {
		s += " until " + stamp(*cl.ExpiresAt)
	}
	return s
}

func (c *call) printTasks(w io.Writer, ts []client.Task, next *string) {
	if len(ts) == 0 {
		fmt.Fprintln(w, "No Tasks.")
	}
	for _, t := range ts {
		c.printTaskLine(w, t)
	}
	if next != nil {
		fmt.Fprintf(w, "More: --cursor %s\n", *next)
	}
}

func (c *call) printTaskLine(w io.Writer, t client.Task) {
	line := fmt.Sprintf("%-9s %-13s %-14s %-14s %s", one(t.Key), stateOf(t), c.whereOf(t), c.skillOf(t), one(t.Title))
	if t.ParentID != nil {
		line += "  [in " + c.taskKey(*t.ParentID) + "]"
	}
	if ls := deref(t.Labels); len(ls) > 0 {
		line += "  [" + c.labelNames(t) + "]"
	}
	if h := c.claimOf(t.Claim); h != "" {
		line += "  [" + h + "]"
	}
	if bs := deref(t.OpenBlockers); len(bs) > 0 {
		line += "  [blocked by " + names(bs, func(b client.TaskBrief) string { return b.Key }) + "]"
	}
	fmt.Fprintln(w, line)
}

func (c *call) printTaskDetail(w io.Writer, d client.TaskDetail) {
	t := d.Task
	fmt.Fprintf(w, "%s  %s\n", one(t.Key), one(t.Title))
	fmt.Fprintf(w, "  Project    %s\n", c.project(t.ProjectID))
	if d.Parent != nil {
		fmt.Fprintf(w, "  Parent     %s %s\n", one(d.Parent.Key), one(d.Parent.Title))
	}
	fmt.Fprintf(w, "  State      %s (%s)\n", stateOf(t), one(string(t.Kind)))
	switch {
	case t.SubtaskCounts != nil:
		n := t.SubtaskCounts
		fmt.Fprintf(w, "  Subtasks   %d open (%d working), %d done, %d dropped\n", n.Open, n.Working, n.Done, n.Dropped)
		how := "by its Owner (darkory complete " + one(t.Key) + ")"
		if t.AutoComplete {
			how = "by itself when its last Subtask ends Done"
		}
		if t.Acceptance {
			how += ", after an Acceptance"
		}
		fmt.Fprintf(w, "  Completes  %s\n", how)
	case t.AimedAtID != nil:
		fmt.Fprintf(w, "  Aimed at   %s\n", c.member(*t.AimedAtID))
	case d.Step != nil:
		skill := "a hold: a person moves it on (darkory move)"
		if d.Step.SkillID != nil {
			skill = c.skill(*d.Step.SkillID)
		}
		fmt.Fprintf(w, "  Step       %s (%s)", one(d.Step.Name), skill)
		if t.StepSince != nil {
			fmt.Fprintf(w, " since %s", stamp(*t.StepSince))
		}
		fmt.Fprintln(w)
	}
	if len(d.Connectors) > 0 {
		from := deref(t.WorkflowID)
		if d.Step != nil {
			from = d.Step.WorkflowID
		}
		var outs []string
		for _, k := range d.Connectors {
			to := "Done"
			if k.ToStepID != nil {
				to = c.stepFrom(t.ProjectID, from, *k.ToStepID)
			}
			outs = append(outs, one(k.Name)+" → "+to)
		}
		fmt.Fprintf(w, "  Advance    %s\n", strings.Join(outs, " · "))
	}
	owner := "  Owner      " + c.member(t.OwnerID)
	if t.Rank != nil {
		owner += fmt.Sprintf(", Rank %d", *t.Rank)
	}
	fmt.Fprintln(w, owner)
	if len(d.Labels) > 0 {
		fmt.Fprintf(w, "  Labels     %s\n", names(d.Labels, func(l client.Label) string { return l.Name }))
	}
	for i, ws := range d.Workspaces {
		label := "Workspace "
		if i > 0 {
			label = ""
		}
		fmt.Fprintf(w, "  %-10s %s (%s, %s) %s\n", label, one(ws.Name), one(string(ws.Kind)), one(ws.DefaultBranch), one(ws.Path))
	}
	printPullRequest(w, t.PullRequest)
	if cl := t.Claim; cl != nil {
		fmt.Fprintf(w, "  Claim      %s, Session %s", c.member(cl.HolderID), one(cl.SessionID))
		if cl.SkillID != nil {
			fmt.Fprintf(w, ", %s v%d", c.skill(*cl.SkillID), deref(cl.SkillVersion))
		}
		if cl.HeartbeatTimeoutSeconds != nil {
			fmt.Fprintf(w, ", heartbeat timeout %ds, expires %s", *cl.HeartbeatTimeoutSeconds, stamp(deref(cl.ExpiresAt)))
		} else {
			fmt.Fprint(w, ", no heartbeat timeout")
		}
		if cl.ModelLabel != nil {
			fmt.Fprintf(w, ", model %s", one(*cl.ModelLabel))
		}
		fmt.Fprintln(w)
	}
	filer := "Darkory"
	if t.FiledBy != nil {
		filer = c.member(*t.FiledBy)
	}
	fmt.Fprintf(w, "  Filed      by %s at %s, waiting since %s\n", filer, stamp(t.CreatedAt), stamp(t.WaitingSince))
	if t.EndedAt != nil {
		fmt.Fprintf(w, "  Ended      %s\n", stamp(*t.EndedAt))
	}
	if t.Description != "" {
		fmt.Fprintf(w, "\n%s\n", indent(t.Description))
	}
	section := func(title string, n int) bool {
		if n == 0 {
			return false
		}
		fmt.Fprintf(w, "\n%s:\n", title)
		return true
	}
	if section("Subtasks", len(d.Subtasks)) {
		for _, st := range d.Subtasks {
			fmt.Fprint(w, "  ")
			c.printTaskLine(w, st)
		}
	}
	if section("Blocked by", len(d.Blockers)) {
		for _, b := range d.Blockers {
			fmt.Fprint(w, "  ")
			c.printTaskLine(w, b)
		}
	}
	if section("Blocking", len(d.Blocking)) {
		for _, b := range d.Blocking {
			fmt.Fprint(w, "  ")
			c.printTaskLine(w, b)
		}
	}
	if section("Notes", len(d.Notes)) {
		for _, n := range d.Notes {
			who := c.member(n.AuthorID)
			if n.SkillID != nil {
				who += " as " + c.skill(*n.SkillID)
			}
			fmt.Fprintf(w, "  %s %s:\n%s\n", stamp(n.CreatedAt), who, indent(n.Body))
		}
	}
	if section("Observations", len(d.Observations)) {
		for _, o := range d.Observations {
			c.printObservation(w, o)
		}
	}
	if section("Evidence", len(d.Evidence)) {
		for _, e := range d.Evidence {
			c.printEvidence(w, e)
		}
	}
	for _, p := range d.Proposals {
		fmt.Fprintln(w)
		c.printProposal(w, p, t.Key)
	}
	if section("Claims", len(d.Claims)) {
		for _, cl := range d.Claims {
			how := "live"
			if cl.HowEnded != nil {
				how = one(string(*cl.HowEnded))
			}
			fmt.Fprintf(w, "  %s %s (%s)\n", stamp(cl.StartedAt), c.member(cl.HolderID), how)
		}
	}
}

func indent(s string) string {
	var b strings.Builder
	for line := range strings.Lines(strings.TrimRight(s, "\n")) {
		b.WriteString("    " + line)
	}
	return b.String()
}

func (c *call) printObservation(w io.Writer, o client.Observation) {
	who := c.member(o.AuthorID)
	if o.SkillID != nil {
		who += " as " + c.skill(*o.SkillID)
	}
	reviewed := ""
	if o.ReviewedAt != nil {
		reviewed = " (reviewed)"
	}
	fmt.Fprintf(w, "  %-11s %s, %s%s: %s\n", one(string(o.Outcome)), who, stamp(o.CreatedAt), reviewed, one(o.Body))
}

func (c *call) printEvidence(w io.Writer, e client.Evidence) {
	kind := ""
	if e.Kind == client.EvidenceKindLog {
		kind = "  Shift log"
	}
	fmt.Fprintf(w, "  %s  %s  %s  %d bytes%s  by %s at %s\n", one(e.ID), one(e.Filename), one(e.ContentType), e.Size, kind, c.member(e.AttachedBy), stamp(e.CreatedAt))
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func (c *call) printMemberLine(w io.Writer, m client.Member) {
	extra := ""
	if m.Admin {
		extra += " admin"
	}
	if m.Email != nil {
		extra += " " + one(*m.Email)
	}
	if m.ManagerID != nil {
		extra += " reports to " + c.member(*m.ManagerID)
	}
	if m.DeactivatedAt != nil {
		extra += " deactivated " + stamp(*m.DeactivatedAt)
	}
	fmt.Fprintf(w, "%-16s %-6s%s\n", one(m.Name), one(string(m.Kind)), extra)
}

func (c *call) printSession(w io.Writer, s client.Session) {
	how := "token " + one(deref(s.TokenID))
	if s.Kind == client.SessionKindBrowser {
		how = "browser"
		if s.ExpiresAt != nil {
			how += ", expires " + stamp(*s.ExpiresAt)
		}
	}
	fmt.Fprintf(w, "%-40s %s, last seen %s, started %s\n", one(s.ID), how, stamp(s.LastSeenAt), stamp(s.StartedAt))
}

func names[T any](items []T, name func(T) string) string {
	var out []string
	for _, it := range items {
		out = append(out, one(name(it)))
	}
	if len(out) == 0 {
		return "-"
	}
	sort.Strings(out)
	return strings.Join(out, ", ")
}

func (c *call) printSkillLine(w io.Writer, s client.Skill) {
	extra := ""
	if s.BaseSkillID != nil {
		extra = " on " + c.skill(*s.BaseSkillID)
	}
	if s.ProjectID != nil {
		extra += ", Project " + c.project(*s.ProjectID)
	}
	if s.Builtin {
		extra += " (built in)"
	}
	fmt.Fprintf(w, "%-20s %-8s v%d%s\n", one(s.Name), one(string(s.Kind)), s.CurrentVersion, extra)
}

func (c *call) printToken(w io.Writer, t client.Token) {
	state := "live"
	if t.RevokedAt != nil {
		state = "revoked " + stamp(*t.RevokedAt)
	}
	timeout := "no default timeout"
	if t.DefaultHeartbeatTimeoutSeconds != nil {
		timeout = fmt.Sprintf("default timeout %ds", *t.DefaultHeartbeatTimeoutSeconds)
	}
	fmt.Fprintf(w, "%s  %-16s %s…  %s, %s\n", one(t.ID), one(t.Name), one(t.Prefix), timeout, state)
}

func (c *call) printActivity(w io.Writer, a client.Activity) {
	actor := "darkory"
	if a.ActorID != nil {
		actor = c.member(*a.ActorID)
	}
	payload := ""
	if len(a.Payload) > 0 {
		b, _ := json.Marshal(a.Payload)
		payload = " " + string(b)
	}
	fmt.Fprintf(w, "%6d %s %-12s %-22s %s%s\n", a.Seq, stamp(a.At), actor, one(string(a.Kind)), one(a.SubjectID), one(payload))
}

// printProposal prints a Skill proposal; task names its Task when known.
func (c *call) printProposal(w io.Writer, p client.SkillProposal, task string) {
	if task == "" {
		task = p.TaskID
	}
	fmt.Fprintf(w, "Proposal %s on %s: %s\n", one(p.ID), one(task), one(string(p.State)))
	fmt.Fprintf(w, "  Skill      %s, written against v%d", c.skill(p.SkillID), p.BasedOnVersion)
	if p.PublishedVersion != nil {
		fmt.Fprintf(w, ", published as v%d", *p.PublishedVersion)
	}
	fmt.Fprintf(w, "\n  By         %s at %s", c.member(p.AuthorID), stamp(p.CreatedAt))
	if p.DecidedAt != nil {
		fmt.Fprintf(w, ", decided %s", stamp(*p.DecidedAt))
	}
	fmt.Fprintf(w, "\n\n%s\n", indent(p.Body))
}
