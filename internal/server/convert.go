package server

import (
	"time"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/server/gen"
	"github.com/tuongaz/darkory/internal/shortid"
)

// Conversions from the core's records to the API's schemas.

func seconds(d time.Duration) *int {
	if d <= 0 {
		return nil
	}
	n := int(d / time.Second)
	return &n
}

func each[T, U any](in []T, conv func(T) U) []U {
	out := make([]U, 0, len(in))
	for _, v := range in {
		out = append(out, conv(v))
	}
	return out
}

// some is a copy of in, or nil when it is empty: the API leaves out a list with no items unless
// its schema requires it.
func some[T any](in []T) *[]T {
	if len(in) == 0 {
		return nil
	}
	out := append([]T(nil), in...)
	return &out
}

// optional is s, or nil when it is empty.
func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func memberOut(m core.Member) gen.Member {
	out := gen.Member{ID: shortid.Of(m.ID), Name: m.Name, Kind: gen.MemberKind(m.Kind), Email: m.Email, Admin: m.Admin, ManagerID: shortid.OfPtr(m.ManagerID),
		CreatedAt: m.CreatedAt, DeactivatedAt: m.DeactivatedAt, AvatarFileID: shortid.OfPtr(m.AvatarFileID)}
	if a := m.Agent; a != nil {
		out.Agent = &gen.AgentSettings{Command: a.Command, Args: a.Args, Model: a.Model, Env: a.Env, Unattended: a.Unattended,
			Paused: a.Paused, ProgressFile: optional(a.ProgressFile)}
	}
	return out
}

func memberDetailOut(d core.MemberDetail) gen.MemberDetail {
	return gen.MemberDetail{Member: memberOut(d.Member), Projects: each(d.Projects, projectOut), Skills: each(d.Skills, skillOut),
		Reports: each(d.Reports, memberOut)}
}

func projectOut(p core.Project) gen.Project {
	return gen.Project{ID: shortid.Of(p.ID), Key: p.Key, Name: p.Name, DefaultWorkspaceID: shortid.OfPtr(p.DefaultWorkspaceID), AutoComplete: p.AutoComplete,
		Acceptance: p.Acceptance, CreatedAt: p.CreatedAt}
}

func projectDetailOut(d core.ProjectDetail) gen.ProjectDetail {
	return gen.ProjectDetail{Project: projectOut(d.Project), Members: each(d.Members, memberOut)}
}

func workspaceOut(w core.Workspace) gen.Workspace {
	return gen.Workspace{ID: shortid.Of(w.ID), Name: w.Name, Kind: gen.WorkspaceKind(w.Kind), Path: w.Path, Mode: gen.WorkspaceMode(w.Mode),
		DefaultBranch: w.DefaultBranch, CreatedAt: w.CreatedAt}
}

func skillOut(s core.Skill) gen.Skill {
	return gen.Skill{ID: shortid.Of(s.ID), Name: s.Name, Kind: gen.SkillKind(s.Kind), BaseSkillID: shortid.OfPtr(s.BaseSkillID), Builtin: s.Builtin,
		CurrentVersion: s.CurrentVersion, CreatedAt: s.CreatedAt}
}

func skillVersionOut(v core.SkillVersion) gen.SkillVersion {
	return gen.SkillVersion{SkillID: shortid.Of(v.SkillID), Version: v.Version, Body: v.Body, ProposalID: shortid.OfPtr(v.ProposalID),
		PublishedBy: shortid.OfPtr(v.PublishedBy), PublishedAt: v.PublishedAt}
}

func skillDetailOut(d core.SkillDetail) gen.SkillDetail {
	return gen.SkillDetail{Skill: skillOut(d.Skill), Current: skillVersionOut(d.Current)}
}

func stepOut(s core.Step) gen.Step {
	return gen.Step{ID: shortid.Of(s.ID), Name: s.Name, SkillID: shortid.OfPtr(s.SkillID), Position: s.Position, X: s.X, Y: s.Y}
}

func connectorOut(k core.Connector) gen.Connector {
	return gen.Connector{ID: shortid.Of(k.ID), FromStepID: shortid.Of(k.FromStepID), ToStepID: shortid.OfPtr(k.ToStepID), Name: k.Name, Position: k.Position}
}

// workflowOut renders a Workflow with each Step's live facts; facts are in the order of the Steps.
func workflowOut(d core.WorkflowDetail) gen.Workflow {
	out := gen.Workflow{ProjectID: shortid.Of(d.ProjectID), Steps: make([]gen.WorkflowStep, 0, len(d.Steps)), Connectors: each(d.Connectors, connectorOut)}
	for i, s := range d.Steps {
		ws := gen.WorkflowStep{ID: shortid.Of(s.ID), Name: s.Name, SkillID: shortid.OfPtr(s.SkillID), Position: s.Position, X: s.X, Y: s.Y, Takers: []gen.Taker{}}
		if i < len(d.Facts) {
			f := d.Facts[i]
			ws.Tasks, ws.Working, ws.MedianMs = f.Tasks, f.Working, f.MedianMS
			ws.Takers = each(f.Takers, func(t core.Taker) gen.Taker {
				return gen.Taker{ID: shortid.Of(t.MemberID), Name: t.Name, Kind: gen.MemberKind(t.Kind)}
			})
		}
		out.Steps = append(out.Steps, ws)
	}
	return out
}

func labelOut(l core.Label) gen.Label {
	return gen.Label{ID: shortid.Of(l.ID), ProjectID: shortid.OfPtr(l.ProjectID), Name: l.Name, Color: l.Color, CreatedAt: l.CreatedAt}
}

func claimOut(c core.Claim) gen.Claim {
	out := gen.Claim{ID: shortid.Of(c.ID), TaskID: shortid.Of(c.TaskID), HolderID: shortid.Of(c.HolderID), SessionID: shortid.Of(c.SessionID), SkillID: shortid.OfPtr(c.SkillID),
		SkillVersion: c.SkillVersion, ModelLabel: c.ModelLabel, HeartbeatTimeoutSeconds: seconds(c.Timeout),
		StartedAt: c.StartedAt, ExpiresAt: c.ExpiresAt, EndedAt: c.EndedAt}
	if c.HowEnded != nil {
		how := gen.ClaimEnd(*c.HowEnded)
		out.HowEnded = &how
	}
	return out
}

func taskBriefOut(b core.TaskBrief) gen.TaskBrief {
	return gen.TaskBrief{ID: shortid.Of(b.ID), Key: b.Key, Title: b.Title}
}

func taskOut(t core.Task) gen.Task {
	out := gen.Task{ID: shortid.Of(t.ID), Key: t.Key, ProjectID: shortid.Of(t.ProjectID), ParentID: shortid.OfPtr(t.ParentID), Kind: gen.TaskKind(t.Kind), Title: t.Title,
		Description: t.Description, State: gen.TaskState(t.State), OwnerID: shortid.Of(t.OwnerID), Rank: t.Rank, StepID: shortid.OfPtr(t.StepID),
		StepSince: t.StepSince, SkillID: shortid.OfPtr(t.SkillID), AimedAtID: shortid.OfPtr(t.AimedAtID), Labels: some(shortid.OfAll(t.Labels)), Breakdown: t.Breakdown,
		AutoComplete: t.AutoComplete, Acceptance: t.Acceptance, FromRetrospectiveTaskID: shortid.OfPtr(t.FromRetrospectiveTaskID), Blocked: t.Blocked,
		WorkspaceIds: some(shortid.OfAll(t.WorkspaceIDs)), FiledBy: shortid.OfPtr(t.FiledBy), WaitingSince: t.WaitingSince, CreatedAt: t.CreatedAt, EndedAt: t.EndedAt}
	if t.Claim != nil {
		c := claimOut(*t.Claim)
		out.Claim = &c
	}
	if len(t.OpenBlockers) > 0 {
		bs := each(t.OpenBlockers, taskBriefOut)
		out.OpenBlockers = &bs
	}
	if n := t.SubtaskCounts; n != nil {
		out.SubtaskCounts = &gen.SubtaskCounts{Open: n.Open, Working: n.Working, Done: n.Done, Dropped: n.Dropped}
	}
	return out
}

func taskDetailOut(d core.TaskDetail) gen.TaskDetail {
	out := gen.TaskDetail{
		Task: taskOut(d.Task), Subtasks: each(d.Subtasks, taskOut), Connectors: each(d.Connectors, connectorOut),
		Labels: each(d.Labels, labelOut), Workspaces: each(d.Workspaces, workspaceOut), Claims: each(d.Claims, claimOut),
		Notes: each(d.Notes, noteOut), Evidence: each(d.Evidence, evidenceOut), Blockers: each(d.Blockers, taskOut),
		Blocking: each(d.Blocking, taskOut), Observations: each(d.Observations, observationOut),
		Proposals: each(d.Proposals, proposalOut),
	}
	if d.Parent != nil {
		p := taskBriefOut(*d.Parent)
		out.Parent = &p
	}
	if d.Step != nil {
		st := stepOut(*d.Step)
		out.Step = &st
	}
	return out
}

func proposalOut(p core.SkillProposal) gen.SkillProposal {
	return gen.SkillProposal{ID: shortid.Of(p.ID), SkillID: shortid.Of(p.SkillID), TaskID: shortid.Of(p.TaskID), BasedOnVersion: p.BasedOnVersion, Body: p.Body,
		AuthorID: shortid.Of(p.AuthorID), State: gen.ProposalState(p.State), PublishedVersion: p.PublishedVersion, CreatedAt: p.CreatedAt,
		DecidedAt: p.DecidedAt}
}

func noteOut(n core.Note) gen.Note {
	return gen.Note{ID: shortid.Of(n.ID), TaskID: shortid.Of(n.TaskID), AuthorID: shortid.Of(n.AuthorID), SkillID: shortid.OfPtr(n.SkillID), Body: n.Body, CreatedAt: n.CreatedAt}
}

func observationOut(o core.Observation) gen.Observation {
	return gen.Observation{ID: shortid.Of(o.ID), TaskID: shortid.Of(o.TaskID), AuthorID: shortid.Of(o.AuthorID), SkillID: shortid.OfPtr(o.SkillID),
		Outcome: gen.ObservationOutcome(o.Outcome), Body: o.Body, CreatedAt: o.CreatedAt, ReviewedByTaskID: shortid.OfPtr(o.ReviewedByTaskID),
		ReviewedAt: o.ReviewedAt}
}

func evidenceOut(e core.Evidence) gen.Evidence {
	return gen.Evidence{ID: shortid.Of(e.ID), TaskID: shortid.Of(e.TaskID), Filename: e.Filename, ContentType: e.ContentType,
		Size: e.Size, Sha256: e.SHA256, AttachedBy: shortid.Of(e.AttachedBy), CreatedAt: e.CreatedAt}
}

func activityOut(a core.Activity) gen.Activity {
	return gen.Activity{Seq: a.Seq, At: a.At, ActorID: shortid.OfPtr(a.ActorID), Kind: gen.ActivityKind(a.Kind),
		SubjectType: gen.SubjectType(a.SubjectType), SubjectID: shortid.Of(a.SubjectID), Payload: shortIDs(a.Payload)}
}

// textKeys are the free-form fields an Activity payload or an Error's details may carry: what a
// person typed or chose, or what a program was told to run. Their values are kept as written,
// even one that happens to be spelled as a UUID.
var textKeys = map[string]bool{
	"name": true, "title": true, "title_json": true, "body": true, "description": true, "reason": true, "email": true,
	"key": true, "blocker_key": true, "outcome": true, "path": true, "filename": true, "content_type": true,
	"mode": true, "default_branch": true, "color": true, "kind": true, "how": true, "how_ended": true,
	"purpose": true, "model": true, "model_label": true, "command": true, "args": true, "env": true,
	"progress_file": true, "message": true, "workflow": true, "refused": true, "outcomes": true,
}

// shortIDs is a copy of a free-form map (an Activity payload, an Error's details) with every id in
// it, at any depth and as a map key too, in its short form (ADR 0017). An id there is a string
// spelled as a UUID outside the free-form fields of textKeys; storage keeps them canonical.
func shortIDs(m map[string]any) map[string]any {
	if m == nil {
		return nil
	}
	out := make(map[string]any, len(m))
	for k, v := range m {
		if textKeys[k] {
			out[k] = v
			continue
		}
		out[shortid.Short(k)] = shortIDsIn(v)
	}
	return out
}

func shortIDsIn(v any) any {
	switch v := v.(type) {
	case string:
		return shortid.Short(v)
	case map[string]any:
		return shortIDs(v)
	case []any:
		out := make([]any, len(v))
		for i, e := range v {
			out[i] = shortIDsIn(e)
		}
		return out
	case []string:
		out := make([]string, len(v))
		for i, e := range v {
			out[i] = shortid.Short(e)
		}
		return out
	default:
		return v
	}
}

func tokenOut(t core.Token) gen.Token {
	return gen.Token{ID: shortid.Of(t.ID), MemberID: shortid.Of(t.MemberID), Name: t.Name, Prefix: t.Prefix,
		DefaultHeartbeatTimeoutSeconds: seconds(t.DefaultTimeout), CreatedAt: t.CreatedAt, LastUsedAt: t.LastUsedAt, RevokedAt: t.RevokedAt}
}

func sessionOut(s core.Session) gen.Session {
	return gen.Session{ID: shortid.Of(s.ID), MemberID: shortid.Of(s.MemberID), Kind: gen.SessionKind(s.Kind), TokenID: shortid.OfPtr(s.TokenID),
		StartedAt: s.StartedAt, LastSeenAt: s.LastSeenAt, ExpiresAt: s.ExpiresAt, ClosedAt: s.ClosedAt, EndedAt: s.EndedAt}
}

func pageCursor(next string) *string {
	if next == "" {
		return nil
	}
	return &next
}
