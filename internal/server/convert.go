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
	return gen.MemberDetail{Member: memberOut(d.Member), Teams: each(d.Teams, teamOut), Skills: each(d.Skills, skillOut), Reports: each(d.Reports, memberOut)}
}

func teamOut(t core.Team) gen.Team {
	return gen.Team{ID: t.ID, Key: t.Key, Name: t.Name, DefaultWorkspaceID: t.DefaultWorkspaceID, ShipWhenDone: t.ShipWhenDone, CreatedAt: t.CreatedAt}
}

func workspaceOut(w core.Workspace) gen.Workspace {
	return gen.Workspace{ID: w.ID, Name: w.Name, Kind: gen.WorkspaceKind(w.Kind), Path: w.Path, Mode: gen.WorkspaceMode(w.Mode),
		DefaultBranch: w.DefaultBranch, CreatedAt: w.CreatedAt}
}

func teamDetailOut(d core.TeamDetail) gen.TeamDetail {
	return gen.TeamDetail{Team: teamOut(d.Team), Members: each(d.Members, memberOut)}
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

func featureOut(f core.Feature) gen.Feature {
	return gen.Feature{ID: f.ID, Key: f.Key, TeamID: f.TeamID, Title: f.Title, Description: f.Description, OwnerID: f.OwnerID,
		State: gen.FeatureState(f.State), Rank: f.Rank, FromRetrospectiveTaskID: f.FromRetrospectiveTaskID, Quick: f.Quick,
		ShipWhenDone: f.ShipWhenDone, FiledBy: f.FiledBy,
		CreatedAt: f.CreatedAt, EndedAt: f.EndedAt,
		TaskCounts: gen.TaskCounts{Open: f.TaskCounts.Open, Claimed: f.TaskCounts.Claimed, Done: f.TaskCounts.Done, Dropped: f.TaskCounts.Dropped}}
}

func featureDetailOut(d core.FeatureDetail) gen.FeatureDetail {
	return gen.FeatureDetail{Feature: featureOut(d.Feature), Tasks: each(d.Tasks, taskOut), Evidence: each(d.Evidence, evidenceOut)}
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

func taskOut(t core.Task) gen.Task {
	out := gen.Task{ID: t.ID, Key: t.Key, FeatureID: t.FeatureID, Kind: gen.TaskKind(t.Kind), Title: t.Title,
		Description: t.Description, State: gen.TaskState(t.State), StatusID: t.StatusID, SkillID: t.SkillID, AimedAtID: t.AimedAtID,
		Blocked: t.Blocked, FiledBy: t.FiledBy, WaitingSince: t.WaitingSince, CreatedAt: t.CreatedAt, EndedAt: t.EndedAt}
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
		Task: taskOut(d.Task), Status: statusOut(d.Status), Feature: featureOut(d.Feature), Workspaces: each(d.Workspaces, workspaceOut),
		Claims: each(d.Claims, claimOut),
		Notes: each(d.Notes, noteOut), Evidence: each(d.Evidence, evidenceOut), Blockers: each(d.Blockers, taskOut),
		Blocking: each(d.Blocking, taskOut), Observations: each(d.Observations, observationOut),
	}
	if d.Proposal != nil {
		p := proposalOut(*d.Proposal)
		out.Proposal = &p
	}
	return out
}

func statusOut(s core.Status) gen.Status {
	return gen.Status{ID: s.ID, Name: s.Name, Kind: gen.StatusKind(s.Kind), Position: s.Position}
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
	return gen.Observation{ID: o.ID, TaskID: o.TaskID, FeatureID: o.FeatureID, AuthorID: o.AuthorID, SkillID: o.SkillID,
		Outcome: gen.ObservationOutcome(o.Outcome), Body: o.Body, CreatedAt: o.CreatedAt, ReviewedByTaskID: o.ReviewedByTaskID,
		ReviewedAt: o.ReviewedAt}
}

func evidenceOut(e core.Evidence) gen.Evidence {
	return gen.Evidence{ID: e.ID, FeatureID: e.FeatureID, TaskID: e.TaskID, Filename: e.Filename, ContentType: e.ContentType,
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
