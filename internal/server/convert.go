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
	return gen.Member{ID: m.ID, Name: m.Name, Kind: gen.MemberKind(m.Kind), Email: m.Email, Admin: m.Admin, ManagerID: m.ManagerID, CreatedAt: m.CreatedAt}
}

func memberDetailOut(d core.MemberDetail) gen.MemberDetail {
	return gen.MemberDetail{Member: memberOut(d.Member), Teams: each(d.Teams, teamOut), Skills: each(d.Skills, skillOut), Reports: each(d.Reports, memberOut)}
}

func teamOut(t core.Team) gen.Team {
	return gen.Team{ID: t.ID, Key: t.Key, Name: t.Name, CreatedAt: t.CreatedAt}
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
		State: gen.FeatureState(f.State), Rank: f.Rank, FromRetrospectiveTaskID: f.FromRetrospectiveTaskID, FiledBy: f.FiledBy,
		CreatedAt: f.CreatedAt, EndedAt: f.EndedAt}
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
		Description: t.Description, State: gen.TaskState(t.State), SkillID: t.SkillID, AimedAtID: t.AimedAtID,
		Blocked: t.Blocked, FiledBy: t.FiledBy, WaitingSince: t.WaitingSince, CreatedAt: t.CreatedAt, EndedAt: t.EndedAt}
	if t.Claim != nil {
		c := claimOut(*t.Claim)
		out.Claim = &c
	}
	return out
}

func taskDetailOut(d core.TaskDetail) gen.TaskDetail {
	return gen.TaskDetail{
		Task: taskOut(d.Task), Feature: featureOut(d.Feature), Claims: each(d.Claims, claimOut),
		Notes: each(d.Notes, noteOut), Evidence: each(d.Evidence, evidenceOut), Blockers: each(d.Blockers, taskOut),
		Blocking: each(d.Blocking, taskOut), Observations: each(d.Observations, observationOut),
	}
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
	return gen.Activity{Seq: a.Seq, At: a.At, ActorID: a.ActorID, Kind: a.Kind, SubjectID: a.SubjectID, Payload: a.Payload}
}

func tokenOut(t core.Token) gen.Token {
	return gen.Token{ID: t.ID, MemberID: t.MemberID, Name: t.Name, Prefix: t.Prefix,
		DefaultHeartbeatTimeoutSeconds: seconds(t.DefaultTimeout), CreatedAt: t.CreatedAt, LastUsedAt: t.LastUsedAt, RevokedAt: t.RevokedAt}
}

func sessionOut(s core.Session) gen.Session {
	return gen.Session{ID: s.ID, MemberID: s.MemberID, Kind: gen.SessionKind(s.Kind), TokenID: s.TokenID,
		StartedAt: s.StartedAt, LastSeenAt: s.LastSeenAt, ClosedAt: s.ClosedAt}
}

func pageCursor(next string) *string {
	if next == "" {
		return nil
	}
	return &next
}
