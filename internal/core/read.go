package core

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/tuongaz/darkory/internal/store"
)

// Readers for each record. They take a store.Reader so a write can read inside its own
// transaction and a read can run outside any.

const memberCols = `m.id, m.name, m.kind, m.email, m.admin, m.created_at, r.manager_id`
const memberFrom = `members m LEFT JOIN reporting_lines r ON r.member_id = m.id`

func scanMember(row interface{ Scan(...any) error }) (Member, error) {
	var m Member
	var email, manager sql.NullString
	var created int64
	if err := row.Scan(&m.ID, &m.Name, &m.Kind, &email, &m.Admin, &created, &manager); err != nil {
		return m, err
	}
	m.Email, m.ManagerID, m.CreatedAt = nullString(email), nullString(manager), fromMS(created)
	return m, nil
}

const teamCols = `tm.id, tm.key_prefix, tm.name, tm.created_at`

func scanTeam(row interface{ Scan(...any) error }) (Team, error) {
	var t Team
	var created int64
	err := row.Scan(&t.ID, &t.Key, &t.Name, &created)
	t.CreatedAt = fromMS(created)
	return t, err
}

const skillCols = `sk.id, sk.name, sk.kind, sk.base_skill_id, sk.builtin, sk.current_version, sk.created_at`

func scanSkill(row interface{ Scan(...any) error }) (Skill, error) {
	var s Skill
	var base sql.NullString
	var created int64
	err := row.Scan(&s.ID, &s.Name, &s.Kind, &base, &s.Builtin, &s.CurrentVersion, &created)
	s.BaseSkillID, s.CreatedAt = nullString(base), fromMS(created)
	return s, err
}

const featureCols = `f.id, f.display_key, f.team_id, f.title, f.description, f.owner_id, f.state, f.rank,
f.from_retrospective_task_id, f.filed_by, f.created_at, f.ended_at`

func scanFeature(row interface{ Scan(...any) error }) (Feature, error) {
	var f Feature
	var fromRetro sql.NullString
	var created int64
	var ended sql.NullInt64
	err := row.Scan(&f.ID, &f.Key, &f.TeamID, &f.Title, &f.Description, &f.OwnerID, &f.State, &f.Rank,
		&fromRetro, &f.FiledBy, &created, &ended)
	f.FromRetrospectiveTaskID, f.CreatedAt, f.EndedAt = nullString(fromRetro), fromMS(created), nullTime(ended)
	return f, err
}

// taskCols reads a Task with its current Claim; scanTask shows the Claim only while it is live.
const taskCols = `t.id, t.display_key, t.feature_id, t.kind, t.title, t.description, t.state, t.skill_id,
t.aimed_at_id, t.filed_by, t.waiting_since, t.created_at, t.ended_at,
t.claim_id, t.claim_holder_id, cs.chosen_id, t.claim_skill_id, cc.skill_version, cc.model_label,
t.claim_timeout_ms, cc.started_at, t.claim_expires_at,
EXISTS (SELECT 1 FROM blocks b JOIN tasks bt ON bt.id = b.blocker_task_id WHERE b.task_id = t.id AND bt.state = 'open')`

const taskFrom = `tasks t LEFT JOIN claims cc ON cc.id = t.claim_id LEFT JOIN sessions cs ON cs.id = t.claim_session_id`

func scanTask(row interface{ Scan(...any) error }, now time.Time) (Task, error) {
	var t Task
	var skill, aimed, claimID, holder, session, claimSkill, label sql.NullString
	var waiting, created int64
	var ended, version, timeout, started, expires sql.NullInt64
	err := row.Scan(&t.ID, &t.Key, &t.FeatureID, &t.Kind, &t.Title, &t.Description, &t.State, &skill,
		&aimed, &t.FiledBy, &waiting, &created, &ended,
		&claimID, &holder, &session, &claimSkill, &version, &label,
		&timeout, &started, &expires, &t.Blocked)
	if err != nil {
		return t, err
	}
	t.SkillID, t.AimedAtID = nullString(skill), nullString(aimed)
	t.WaitingSince, t.CreatedAt, t.EndedAt = fromMS(waiting), fromMS(created), nullTime(ended)
	if holder.Valid && (!expires.Valid || expires.Int64 > ms(now)) {
		c := &Claim{
			ID: claimID.String, TaskID: t.ID, HolderID: holder.String, SessionID: session.String,
			SkillID: nullString(claimSkill), ModelLabel: nullString(label),
			StartedAt: fromMS(started.Int64), ExpiresAt: nullTime(expires),
		}
		if version.Valid {
			c.SkillVersion = &version.Int64
		}
		if timeout.Valid {
			c.Timeout = time.Duration(timeout.Int64) * time.Millisecond
		}
		t.Claim = c
	}
	return t, nil
}

func getMember(ctx context.Context, r store.Reader, orgID, id string) (Member, error) {
	m, err := scanMember(r.QueryRow(ctx, `SELECT `+memberCols+` FROM `+memberFrom+` WHERE m.org_id = $1 AND m.id = $2`, orgID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return m, refuse(CodeNotFound, "no Member %s", id)
	}
	return m, err
}

func getTeam(ctx context.Context, r store.Reader, orgID, id string) (Team, error) {
	t, err := scanTeam(r.QueryRow(ctx, `SELECT `+teamCols+` FROM teams tm WHERE tm.org_id = $1 AND tm.id = $2`, orgID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return t, refuse(CodeNotFound, "no Team %s", id)
	}
	return t, err
}

func getSkill(ctx context.Context, r store.Reader, orgID, id string) (Skill, error) {
	s, err := scanSkill(r.QueryRow(ctx, `SELECT `+skillCols+` FROM skills sk WHERE sk.org_id = $1 AND sk.id = $2`, orgID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return s, refuse(CodeNotFound, "no Skill %s", id)
	}
	return s, err
}

func getFeature(ctx context.Context, r store.Reader, orgID, id string) (Feature, error) {
	f, err := scanFeature(r.QueryRow(ctx, `SELECT `+featureCols+` FROM features f WHERE f.org_id = $1 AND f.id = $2`, orgID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return f, refuse(CodeNotFound, "no Feature %s", id)
	}
	return f, err
}

func getTask(ctx context.Context, r store.Reader, orgID, id string, now time.Time) (Task, error) {
	t, err := scanTask(r.QueryRow(ctx, `SELECT `+taskCols+` FROM `+taskFrom+` WHERE t.org_id = $1 AND t.id = $2`, orgID, id), now)
	if errors.Is(err, sql.ErrNoRows) {
		return t, refuse(CodeNotFound, "no Task %s", id)
	}
	return t, err
}

// collect runs query and scans every row with scan.
func collect[T any](ctx context.Context, r store.Reader, scan func(interface{ Scan(...any) error }) (T, error), query string, args ...any) ([]T, error) {
	rows, err := r.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []T{}
	for rows.Next() {
		v, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func tasksWhere(ctx context.Context, r store.Reader, now time.Time, where string, args ...any) ([]Task, error) {
	return collect(ctx, r, func(row interface{ Scan(...any) error }) (Task, error) { return scanTask(row, now) },
		`SELECT `+taskCols+` FROM `+taskFrom+` JOIN features f ON f.id = t.feature_id WHERE `+where, args...)
}

func memberTeams(ctx context.Context, r store.Reader, orgID, memberID string) ([]Team, error) {
	return collect(ctx, r, scanTeam, `SELECT `+teamCols+` FROM teams tm JOIN team_members x ON x.team_id = tm.id
WHERE tm.org_id = $1 AND x.member_id = $2 ORDER BY tm.name`, orgID, memberID)
}

func memberSkills(ctx context.Context, r store.Reader, orgID, memberID string) ([]Skill, error) {
	return collect(ctx, r, scanSkill, `SELECT `+skillCols+` FROM skills sk JOIN member_skills x ON x.skill_id = sk.id
WHERE sk.org_id = $1 AND x.member_id = $2 ORDER BY sk.name`, orgID, memberID)
}

func getMemberDetail(ctx context.Context, r store.Reader, orgID, id string) (MemberDetail, error) {
	var d MemberDetail
	var err error
	if d.Member, err = getMember(ctx, r, orgID, id); err != nil {
		return d, err
	}
	if d.Teams, err = memberTeams(ctx, r, orgID, id); err != nil {
		return d, err
	}
	if d.Skills, err = memberSkills(ctx, r, orgID, id); err != nil {
		return d, err
	}
	d.Reports, err = collect(ctx, r, scanMember, `SELECT `+memberCols+` FROM `+memberFrom+`
WHERE m.org_id = $1 AND r.manager_id = $2 ORDER BY m.name`, orgID, id)
	return d, err
}

func getTeamDetail(ctx context.Context, r store.Reader, orgID, id string) (TeamDetail, error) {
	var d TeamDetail
	var err error
	if d.Team, err = getTeam(ctx, r, orgID, id); err != nil {
		return d, err
	}
	d.Members, err = collect(ctx, r, scanMember, `SELECT `+memberCols+` FROM `+memberFrom+`
JOIN team_members x ON x.member_id = m.id WHERE m.org_id = $1 AND x.team_id = $2 ORDER BY m.name`, orgID, id)
	return d, err
}

func getSkillVersion(ctx context.Context, r store.Reader, orgID, skillID string, version int64) (SkillVersion, error) {
	v, err := scanSkillVersion(r.QueryRow(ctx, `SELECT `+skillVersionCols+` FROM skill_versions v
WHERE v.org_id = $1 AND v.skill_id = $2 AND v.version = $3`, orgID, skillID, version))
	if errors.Is(err, sql.ErrNoRows) {
		return v, refuse(CodeNotFound, "Skill %s has no version %d", skillID, version)
	}
	return v, err
}

const skillVersionCols = `v.skill_id, v.version, v.body, v.proposal_id, v.published_by, v.published_at`

func scanSkillVersion(row interface{ Scan(...any) error }) (SkillVersion, error) {
	var v SkillVersion
	var proposal, by sql.NullString
	var at int64
	err := row.Scan(&v.SkillID, &v.Version, &v.Body, &proposal, &by, &at)
	v.ProposalID, v.PublishedBy, v.PublishedAt = nullString(proposal), nullString(by), fromMS(at)
	return v, err
}

func getSkillDetail(ctx context.Context, r store.Reader, orgID, id string) (SkillDetail, error) {
	var d SkillDetail
	var err error
	if d.Skill, err = getSkill(ctx, r, orgID, id); err != nil {
		return d, err
	}
	d.Current, err = getSkillVersion(ctx, r, orgID, id, d.Skill.CurrentVersion)
	return d, err
}

const evidenceCols = `e.id, e.feature_id, e.task_id, e.filename, e.content_type, e.size, e.sha256, e.attached_by, e.created_at`

func scanEvidence(row interface{ Scan(...any) error }) (Evidence, error) {
	var e Evidence
	var task sql.NullString
	var at int64
	err := row.Scan(&e.ID, &e.FeatureID, &task, &e.Filename, &e.ContentType, &e.Size, &e.SHA256, &e.AttachedBy, &at)
	e.TaskID, e.CreatedAt = nullString(task), fromMS(at)
	return e, err
}

func getFeatureDetail(ctx context.Context, r store.Reader, orgID, id string, now time.Time) (FeatureDetail, error) {
	var d FeatureDetail
	var err error
	if d.Feature, err = getFeature(ctx, r, orgID, id); err != nil {
		return d, err
	}
	if d.Tasks, err = tasksWhere(ctx, r, now, `t.org_id = $1 AND t.feature_id = $2 ORDER BY t.created_at, t.id`, orgID, id); err != nil {
		return d, err
	}
	d.Evidence, err = collect(ctx, r, scanEvidence, `SELECT `+evidenceCols+` FROM evidence e
WHERE e.org_id = $1 AND e.feature_id = $2 AND e.task_id IS NULL ORDER BY e.created_at, e.id`, orgID, id)
	return d, err
}

// claimsOf lists every Claim on a Task, oldest first. A current Claim whose expiry has passed is
// shown as lapsed at its expiry even before anyone has recorded the lapse (ADR 0004).
func claimsOf(ctx context.Context, r store.Reader, orgID, taskID string, now time.Time) ([]Claim, error) {
	return collect(ctx, r, func(row interface{ Scan(...any) error }) (Claim, error) {
		var c Claim
		var skill, label, how, current sql.NullString
		var version, timeout, ended, expires sql.NullInt64
		var started int64
		if err := row.Scan(&c.ID, &c.TaskID, &c.HolderID, &c.SessionID, &skill, &version, &label, &timeout,
			&started, &ended, &how, &current, &expires); err != nil {
			return c, err
		}
		c.SkillID, c.ModelLabel, c.HowEnded = nullString(skill), nullString(label), nullString(how)
		if version.Valid {
			c.SkillVersion = &version.Int64
		}
		if timeout.Valid {
			c.Timeout = time.Duration(timeout.Int64) * time.Millisecond
		}
		c.StartedAt, c.EndedAt = fromMS(started), nullTime(ended)
		if current.Valid && current.String == c.ID && !ended.Valid {
			c.ExpiresAt = nullTime(expires)
			if expires.Valid && expires.Int64 <= ms(now) {
				c.EndedAt, c.HowEnded = c.ExpiresAt, ptr("lapsed")
			}
		}
		return c, nil
	}, `SELECT c.id, c.task_id, c.holder_id, s.chosen_id, c.skill_id, c.skill_version, c.model_label, c.timeout_ms,
c.started_at, c.ended_at, c.how_ended, t.claim_id, t.claim_expires_at
FROM claims c JOIN sessions s ON s.id = c.session_id JOIN tasks t ON t.id = c.task_id
WHERE c.org_id = $1 AND c.task_id = $2 ORDER BY c.started_at, c.id`, orgID, taskID)
}

func getTaskDetail(ctx context.Context, r store.Reader, orgID, id string, now time.Time) (TaskDetail, error) {
	var d TaskDetail
	var err error
	if d.Task, err = getTask(ctx, r, orgID, id, now); err != nil {
		return d, err
	}
	if d.Feature, err = getFeature(ctx, r, orgID, d.Task.FeatureID); err != nil {
		return d, err
	}
	if d.Claims, err = claimsOf(ctx, r, orgID, id, now); err != nil {
		return d, err
	}
	if d.Notes, err = collect(ctx, r, func(row interface{ Scan(...any) error }) (Note, error) {
		var n Note
		var skill sql.NullString
		var at int64
		err := row.Scan(&n.ID, &n.TaskID, &n.AuthorID, &skill, &n.Body, &at)
		n.SkillID, n.CreatedAt = nullString(skill), fromMS(at)
		return n, err
	}, `SELECT id, task_id, author_id, skill_id, body, created_at FROM notes
WHERE org_id = $1 AND task_id = $2 ORDER BY created_at, id`, orgID, id); err != nil {
		return d, err
	}
	if d.Evidence, err = collect(ctx, r, scanEvidence, `SELECT `+evidenceCols+` FROM evidence e
WHERE e.org_id = $1 AND e.task_id = $2 ORDER BY e.created_at, e.id`, orgID, id); err != nil {
		return d, err
	}
	if d.Blockers, err = tasksWhere(ctx, r, now, `t.org_id = $1 AND t.id IN (SELECT blocker_task_id FROM blocks WHERE task_id = $2)
ORDER BY t.created_at, t.id`, orgID, id); err != nil {
		return d, err
	}
	if d.Blocking, err = tasksWhere(ctx, r, now, `t.org_id = $1 AND t.id IN (SELECT task_id FROM blocks WHERE blocker_task_id = $2)
ORDER BY t.created_at, t.id`, orgID, id); err != nil {
		return d, err
	}
	d.Observations, err = collect(ctx, r, func(row interface{ Scan(...any) error }) (Observation, error) {
		var o Observation
		var skill, reviewedBy sql.NullString
		var at int64
		var reviewedAt sql.NullInt64
		err := row.Scan(&o.ID, &o.TaskID, &o.FeatureID, &o.AuthorID, &skill, &o.Outcome, &o.Body, &at, &reviewedBy, &reviewedAt)
		o.SkillID, o.CreatedAt, o.ReviewedByTaskID, o.ReviewedAt = nullString(skill), fromMS(at), nullString(reviewedBy), nullTime(reviewedAt)
		return o, err
	}, `SELECT id, task_id, feature_id, author_id, skill_id, outcome, body, created_at, reviewed_by_task_id, reviewed_at
FROM observations WHERE org_id = $1 AND task_id = $2 ORDER BY created_at, id`, orgID, id)
	return d, err
}

func scanActivity(row interface{ Scan(...any) error }) (Activity, error) {
	var a Activity
	var actor sql.NullString
	var at int64
	var payload string
	if err := row.Scan(&a.Seq, &at, &actor, &a.Kind, &a.SubjectID, &payload); err != nil {
		return a, err
	}
	a.At, a.ActorID = fromMS(at), nullString(actor)
	if err := json.Unmarshal([]byte(payload), &a.Payload); err != nil {
		return a, fmt.Errorf("core: activity %d payload: %w", a.Seq, err)
	}
	return a, nil
}

// Cursors are opaque to clients; inside they hold the offset of the next page.

// DefaultLimit is a list's page size when the request names none.
const DefaultLimit = 100

func decodeCursor(cursor string) (int, error) {
	if cursor == "" {
		return 0, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(cursor)
	if err == nil && strings.HasPrefix(string(b), "o:") {
		if n, err := strconv.Atoi(string(b[2:])); err == nil && n >= 0 {
			return n, nil
		}
	}
	return 0, refuse(CodeInvalid, "cursor %q is not one this server gave", cursor)
}

func encodeCursor(offset int) string {
	return base64.RawURLEncoding.EncodeToString([]byte("o:" + strconv.Itoa(offset)))
}

func limitOf(limit int) int {
	if limit <= 0 {
		return DefaultLimit
	}
	return min(limit, 500)
}

// page cuts one more row than the limit asked for into a page and its cursor.
func page[T any](items []T, offset, limit int) Page[T] {
	if len(items) > limit {
		return Page[T]{Items: items[:limit], NextCursor: encodeCursor(offset + limit)}
	}
	return Page[T]{Items: items}
}
