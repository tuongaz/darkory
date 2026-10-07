package server

import (
	"time"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/server/gen"
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

func memberOut(m core.Member) gen.Member {
	out := gen.Member{ID: m.ID, Name: m.Name, Kind: gen.MemberKind(m.Kind), Email: m.Email, Admin: m.Admin, ManagerID: m.ManagerID,
		CreatedAt: m.CreatedAt, DeactivatedAt: m.DeactivatedAt}
	if a := m.Agent; a != nil {
		out.Agent = &gen.AgentSettings{Command: a.Command, Args: a.Args, Model: a.Model, Env: a.Env, Unattended: a.Unattended,
			Paused: a.Paused, ProgressFile: optional(a.ProgressFile)}
	}
	return out
}

// optional is s, or nil when it is empty.
func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func memberDetailOut(d core.MemberDetail) gen.MemberDetail {
	return gen.MemberDetail{Member: memberOut(d.Member), Teams: each(d.Projects, teamOut), Skills: each(d.Skills, skillOut), Reports: each(d.Reports, memberOut)}
}

// teamOut renders a Project in the shape the API still names a Team, its auto_complete as
// ship_when_done. model v2: replaced by the Project schema (M1b).
func teamOut(p core.Project) gen.Team {
	return gen.Team{ID: p.ID, Key: p.Key, Name: p.Name, DefaultWorkspaceID: p.DefaultWorkspaceID, ShipWhenDone: p.AutoComplete, CreatedAt: p.CreatedAt}
}

func workspaceOut(w core.Workspace) gen.Workspace {
	return gen.Workspace{ID: w.ID, Name: w.Name, Kind: gen.WorkspaceKind(w.Kind), Path: w.Path, Mode: gen.WorkspaceMode(w.Mode),
		DefaultBranch: w.DefaultBranch, CreatedAt: w.CreatedAt}
}

func teamDetailOut(d core.ProjectDetail) gen.TeamDetail {
	return gen.TeamDetail{Team: teamOut(d.Project), Members: each(d.Members, memberOut)}
}

func skillOut(s core.Skill) gen.Skill {
	return gen.Skill{ID: s.ID, Name: s.Name, Kind: gen.SkillKind(s.Kind), BaseSkillID: s.BaseSkillID, Builtin: s.Builtin,
		CurrentVersion: s.CurrentVersion, CreatedAt: s.CreatedAt}
}

func skillVersionOut(v core.SkillVersion) gen.SkillVersion {
	return gen.SkillVersion{SkillID: v.SkillID, Version: v.Version, Body: v.Body, ProposalID: v.ProposalID,
		PublishedBy: v.PublishedBy, PublishedAt: v.PublishedAt}
}

func skillDetailOut(d core.SkillDetail) gen.SkillDetail {
	return gen.SkillDetail{Skill: skillOut(d.Skill), Current: skillVersionOut(d.Current)}
}

func claimOut(c core.Claim) gen.Claim {
	out := gen.Claim{ID: c.ID, TaskID: c.TaskID, HolderID: c.HolderID, SessionID: c.SessionID, SkillID: c.SkillID,
		SkillVersion: c.SkillVersion, ModelLabel: c.ModelLabel, HeartbeatTimeoutSeconds: seconds(c.Timeout),
		StartedAt: c.StartedAt, ExpiresAt: c.ExpiresAt, EndedAt: c.EndedAt}
	if c.HowEnded != nil {
		how := gen.ClaimEnd(*c.HowEnded)
		out.HowEnded = &how
	}
	return out
}

// taskOut renders a Task in the shape the API still has: its Parent as its Feature (its own id
// when it has none, as a Feature became a Task with the same id), its Step as its Status. model
// v2: replaced by the Task schema with project, parent, step and labels (M1b).
func taskOut(t core.Task) gen.Task {
	feature := t.ID
	if t.ParentID != nil {
		feature = *t.ParentID
	}
	out := gen.Task{ID: t.ID, Key: t.Key, FeatureID: feature, Kind: gen.TaskKind(t.Kind), Title: t.Title,
		Description: t.Description, State: gen.TaskState(t.State), StatusID: deref(t.StepID), SkillID: t.SkillID, AimedAtID: t.AimedAtID,
		Blocked: t.Blocked, FiledBy: deref(t.FiledBy), WaitingSince: t.WaitingSince, CreatedAt: t.CreatedAt, EndedAt: t.EndedAt}
	if t.Claim != nil {
		c := claimOut(*t.Claim)
		out.Claim = &c
	}
	if len(t.OpenBlockers) > 0 {
		bs := each(t.OpenBlockers, func(b core.TaskBrief) gen.TaskBrief { return gen.TaskBrief{ID: b.ID, Key: b.Key} })
		out.OpenBlockers = &bs
	}
	if len(t.WorkspaceIDs) > 0 {
		ws := append([]string(nil), t.WorkspaceIDs...)
		out.WorkspaceIds = &ws
	}
	return out
}

func taskDetailOut(d core.TaskDetail) gen.TaskDetail {
	out := gen.TaskDetail{
		Task: taskOut(d.Task), Status: stepStatusOut(d), Feature: parentFeatureOut(d), Workspaces: each(d.Workspaces, workspaceOut),
		Claims: each(d.Claims, claimOut), Notes: each(d.Notes, noteOut), Evidence: each(d.Evidence, evidenceOut),
		Blockers: each(d.Blockers, taskOut), Blocking: each(d.Blocking, taskOut), Observations: each(d.Observations, observationOut),
	}
	if d.Proposal != nil {
		p := proposalOut(*d.Proposal)
		out.Proposal = &p
	}
	return out
}

// stepStatusOut renders a Task's Step as the Status the API still has: a hold as backlog, a Step
// with a live Claim as in progress, any other as todo; an ended Task's as done or dropped. model
// v2: replaced by the Step and its Connectors in TaskDetail (M1b).
func stepStatusOut(d core.TaskDetail) gen.Status {
	switch {
	case d.Task.State != "open":
		return gen.Status{Name: d.Task.State, Kind: gen.StatusKind(d.Task.State)}
	case d.Step == nil:
		return gen.Status{Kind: gen.StatusKind("todo")}
	}
	kind := "todo"
	switch {
	case d.Step.SkillID == nil:
		kind = "backlog"
	case d.Task.Claim != nil:
		kind = "in_progress"
	}
	return gen.Status{ID: d.Step.ID, Name: d.Step.Name, Kind: gen.StatusKind(kind), Position: d.Step.Position}
}

// parentFeatureOut renders a Task's Parent, or the Task itself when it has none, as the Feature
// the API still has. model v2: replaced by the parent brief and subtasks in TaskDetail (M1b).
func parentFeatureOut(d core.TaskDetail) gen.Feature {
	t := d.Task
	f := gen.Feature{ID: t.ID, Key: t.Key, TeamID: t.ProjectID, Title: t.Title, Description: t.Description, OwnerID: t.OwnerID,
		State: gen.FeatureState(t.State), FiledBy: deref(t.FiledBy), CreatedAt: t.CreatedAt, EndedAt: t.EndedAt, ShipWhenDone: t.AutoComplete}
	if t.State == "done" {
		f.State = gen.FeatureState("shipped")
	}
	if t.Rank != nil {
		f.Rank = *t.Rank
	}
	if d.Parent != nil {
		f.ID, f.Key, f.Title, f.Description, f.ShipWhenDone = d.Parent.ID, d.Parent.Key, d.Parent.Title, "", false
	}
	return f
}

func proposalOut(p core.SkillProposal) gen.SkillProposal {
	return gen.SkillProposal{ID: p.ID, SkillID: p.SkillID, TaskID: p.TaskID, BasedOnVersion: p.BasedOnVersion, Body: p.Body,
		AuthorID: p.AuthorID, State: gen.ProposalState(p.State), PublishedVersion: p.PublishedVersion, CreatedAt: p.CreatedAt,
		DecidedAt: p.DecidedAt}
}

func noteOut(n core.Note) gen.Note {
	return gen.Note{ID: n.ID, TaskID: n.TaskID, AuthorID: n.AuthorID, SkillID: n.SkillID, Body: n.Body, CreatedAt: n.CreatedAt}
}

func observationOut(o core.Observation) gen.Observation {
	return gen.Observation{ID: o.ID, TaskID: o.TaskID, AuthorID: o.AuthorID, SkillID: o.SkillID,
		Outcome: gen.ObservationOutcome(o.Outcome), Body: o.Body, CreatedAt: o.CreatedAt, ReviewedByTaskID: o.ReviewedByTaskID,
		ReviewedAt: o.ReviewedAt}
}

func evidenceOut(e core.Evidence) gen.Evidence {
	return gen.Evidence{ID: e.ID, TaskID: &e.TaskID, Filename: e.Filename, ContentType: e.ContentType,
		Size: e.Size, Sha256: e.SHA256, AttachedBy: e.AttachedBy, CreatedAt: e.CreatedAt}
}

func activityOut(a core.Activity) gen.Activity {
	return gen.Activity{Seq: a.Seq, At: a.At, ActorID: a.ActorID, Kind: gen.ActivityKind(a.Kind),
		SubjectType: gen.SubjectType(a.SubjectType), SubjectID: a.SubjectID, Payload: a.Payload}
}

func tokenOut(t core.Token) gen.Token {
	return gen.Token{ID: t.ID, MemberID: t.MemberID, Name: t.Name, Prefix: t.Prefix,
		DefaultHeartbeatTimeoutSeconds: seconds(t.DefaultTimeout), CreatedAt: t.CreatedAt, LastUsedAt: t.LastUsedAt, RevokedAt: t.RevokedAt}
}

func sessionOut(s core.Session) gen.Session {
	return gen.Session{ID: s.ID, MemberID: s.MemberID, Kind: gen.SessionKind(s.Kind), TokenID: s.TokenID,
		StartedAt: s.StartedAt, LastSeenAt: s.LastSeenAt, ExpiresAt: s.ExpiresAt, ClosedAt: s.ClosedAt}
}

func pageCursor(next string) *string {
	if next == "" {
		return nil
	}
	return &next
}
