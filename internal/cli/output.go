package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	"github.com/tuongaz/darkory/client"
)

func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339) }

func deref[T any](p *T) T {
	var z T
	if p == nil {
		return z
	}
	return *p
}

// needsOf says what a Task needs: a Skill, or the Member it is aimed at.
func (c *call) needsOf(t client.Task) string {
	switch {
	case t.AimedAtID != nil:
		return "@" + c.member(*t.AimedAtID)
	case t.SkillID != nil:
		return c.skill(*t.SkillID)
	}
	return "-"
}

func stateOf(t client.Task) string {
	s := string(t.State)
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
	line := fmt.Sprintf("%-9s %-13s %-14s %s", t.Key, stateOf(t), c.needsOf(t), t.Title)
	if h := c.claimOf(t.Claim); h != "" {
		line += "  [" + h + "]"
	}
	fmt.Fprintln(w, line)
}

func (c *call) printTaskDetail(w io.Writer, d client.TaskDetail) {
	t := d.Task
	fmt.Fprintf(w, "%s  %s\n", t.Key, t.Title)
	fmt.Fprintf(w, "  Feature    %s %s\n", d.Feature.Key, d.Feature.Title)
	fmt.Fprintf(w, "  State      %s (%s)\n", stateOf(t), t.Kind)
	if t.AimedAtID != nil {
		fmt.Fprintf(w, "  Aimed at   %s\n", c.member(*t.AimedAtID))
	} else if t.SkillID != nil {
		fmt.Fprintf(w, "  Needs      %s\n", c.skill(*t.SkillID))
	}
	if cl := t.Claim; cl != nil {
		fmt.Fprintf(w, "  Claim      %s, Session %s", c.member(cl.HolderID), cl.SessionID)
		if cl.SkillID != nil {
			fmt.Fprintf(w, ", %s v%d", c.skill(*cl.SkillID), deref(cl.SkillVersion))
		}
		if cl.HeartbeatTimeoutSeconds != nil {
			fmt.Fprintf(w, ", heartbeat timeout %ds, expires %s", *cl.HeartbeatTimeoutSeconds, stamp(deref(cl.ExpiresAt)))
		} else {
			fmt.Fprint(w, ", no heartbeat timeout")
		}
		if cl.ModelLabel != nil {
			fmt.Fprintf(w, ", model %s", *cl.ModelLabel)
		}
		fmt.Fprintln(w)
	}
	fmt.Fprintf(w, "  Filed      by %s at %s, waiting since %s\n", c.member(t.FiledBy), stamp(t.CreatedAt), stamp(t.WaitingSince))
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
	if section("Claims", len(d.Claims)) {
		for _, cl := range d.Claims {
			how := "live"
			if cl.HowEnded != nil {
				how = string(*cl.HowEnded)
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
	fmt.Fprintf(w, "  %-11s %s, %s%s: %s\n", o.Outcome, who, stamp(o.CreatedAt), reviewed, o.Body)
}

func (c *call) printEvidence(w io.Writer, e client.Evidence) {
	fmt.Fprintf(w, "  %s  %s  %s  %d bytes  by %s at %s\n", e.ID, e.Filename, e.ContentType, e.Size, c.member(e.AttachedBy), stamp(e.CreatedAt))
}

func (c *call) printFeatureLine(w io.Writer, f client.Feature) {
	fmt.Fprintf(w, "%-9s #%-3d %-8s owner %-12s %s\n", f.Key, f.Rank, f.State, c.member(f.OwnerID), f.Title)
}

func (c *call) printFeatureDetail(w io.Writer, d client.FeatureDetail) {
	f := d.Feature
	fmt.Fprintf(w, "%s  %s\n", f.Key, f.Title)
	fmt.Fprintf(w, "  Team       %s, Rank %d\n", c.team(f.TeamID), f.Rank)
	fmt.Fprintf(w, "  State      %s\n", f.State)
	fmt.Fprintf(w, "  Owner      %s\n", c.member(f.OwnerID))
	fmt.Fprintf(w, "  Filed      by %s at %s\n", c.member(f.FiledBy), stamp(f.CreatedAt))
	if f.EndedAt != nil {
		fmt.Fprintf(w, "  Ended      %s\n", stamp(*f.EndedAt))
	}
	if f.Description != "" {
		fmt.Fprintf(w, "\n%s\n", indent(f.Description))
	}
	fmt.Fprintln(w, "\nTasks:")
	for _, t := range d.Tasks {
		fmt.Fprint(w, "  ")
		c.printTaskLine(w, t)
	}
	if len(d.Evidence) > 0 {
		fmt.Fprintln(w, "\nEvidence:")
		for _, e := range d.Evidence {
			c.printEvidence(w, e)
		}
	}
}

func (c *call) printMemberLine(w io.Writer, m client.Member) {
	extra := ""
	if m.Admin {
		extra += " admin"
	}
	if m.Email != nil {
		extra += " " + *m.Email
	}
	if m.ManagerID != nil {
		extra += " reports to " + c.member(*m.ManagerID)
	}
	fmt.Fprintf(w, "%-16s %-6s%s\n", m.Name, m.Kind, extra)
}

func names[T any](items []T, name func(T) string) string {
	var out []string
	for _, it := range items {
		out = append(out, name(it))
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
	if s.Builtin {
		extra += " (built in)"
	}
	fmt.Fprintf(w, "%-20s %-8s v%d%s\n", s.Name, s.Kind, s.CurrentVersion, extra)
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
	fmt.Fprintf(w, "%s  %-16s %s…  %s, %s\n", t.ID, t.Name, t.Prefix, timeout, state)
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
	fmt.Fprintf(w, "%6d %s %-12s %-22s %s%s\n", a.Seq, stamp(a.At), actor, a.Kind, a.SubjectID, payload)
}
