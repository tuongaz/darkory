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

	"github.com/tuongaz/darkory/internal/shortid"
	"github.com/tuongaz/darkory/internal/store"
)

// Readers for each record. They take a store.Reader so a write can read inside its own
// transaction and a read can run outside any.

const memberCols = `m.id, m.name, m.kind, m.email, m.admin, m.created_at, r.manager_id, m.deactivated_at, m.agent, m.avatar_file_id`
const memberFrom = `members m LEFT JOIN reporting_lines r ON r.member_id = m.id`

func scanMember(row interface{ Scan(...any) error }) (Member, error) {
	var m Member
	var email, manager, agent, avatar sql.NullString
	var created int64
	var deactivated sql.NullInt64
	if err := row.Scan(&m.ID, &m.Name, &m.Kind, &email, &m.Admin, &created, &manager, &deactivated, &agent, &avatar); err != nil {
		return m, err
	}
	m.Email, m.ManagerID, m.CreatedAt, m.DeactivatedAt = nullString(email), nullString(manager), fromMS(created), nullTime(deactivated)
	m.AvatarFileID = nullString(avatar)
	if agent.Valid {
		var a AgentSettings
		if err := json.Unmarshal([]byte(agent.String), &a); err != nil {
			return m, fmt.Errorf("core: the agent settings of %s: %w", m.Name, err)
		}
		m.Agent = &a
	}
	return m, nil
}

const projectCols = `pr.id, pr.key_prefix, pr.name, pr.color, pr.default_workspace_id, pr.auto_complete, pr.acceptance, pr.created_at`

func scanProject(row interface{ Scan(...any) error }) (Project, error) {
	var p Project
	var workspace sql.NullString
	var created int64
	err := row.Scan(&p.ID, &p.Key, &p.Name, &p.Color, &workspace, &p.AutoComplete, &p.Acceptance, &created)
	p.DefaultWorkspaceID, p.CreatedAt = nullString(workspace), fromMS(created)
	return p, err
}

const workspaceCols = `w.id, w.name, w.kind, w.path, w.mode, w.default_branch, w.created_at`

func scanWorkspace(row interface{ Scan(...any) error }) (Workspace, error) {
	var w Workspace
	var created int64
	err := row.Scan(&w.ID, &w.Name, &w.Kind, &w.Path, &w.Mode, &w.DefaultBranch, &created)
	w.CreatedAt = fromMS(created)
	return w, err
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

// taskCols reads a Task with its Step's Skill, the Workflow of its Step or of the Step it ended
// at, the Workflow of its Step alone (for the guards), and its current Claim; scanTask shows the
// Claim only while it is live.
const taskCols = `t.id, t.display_key, t.project_id, t.parent_id, t.kind, t.title, t.description, t.state,
t.step_id, t.step_since, ts.skill_id, t.last_step_id, COALESCE(ts.workflow_id, ls.workflow_id), ts.workflow_id, t.aimed_at_id, t.owner_id, t.rank, t.breakdown, t.auto_complete, t.acceptance,
t.from_retrospective_task_id, t.filed_by, t.waiting_since, t.created_at, t.ended_at,
t.claim_id, t.claim_holder_id, cs.chosen_id, t.claim_skill_id, cc.skill_version, cc.model_label,
t.claim_timeout_ms, cc.started_at, t.claim_expires_at,
EXISTS (SELECT 1 FROM blocks b JOIN tasks bt ON bt.id = b.blocker_task_id
	WHERE b.org_id = t.org_id AND b.task_id = t.id AND bt.state = 'open')`

const taskFrom = `tasks t LEFT JOIN steps ts ON ts.id = t.step_id AND ts.org_id = t.org_id
LEFT JOIN steps ls ON ls.id = t.last_step_id AND ls.org_id = t.org_id
LEFT JOIN claims cc ON cc.id = t.claim_id
LEFT JOIN sessions cs ON cs.id = t.claim_session_id`

func scanTask(row interface{ Scan(...any) error }, now time.Time) (Task, error) {
	var t Task
	var parent, step, skill, lastStep, workflow, stepWorkflow, aimed, fromRetro, filedBy, claimID, holder, session, claimSkill, label sql.NullString
	var waiting, created int64
	var stepSince, rank, ended, version, timeout, started, expires sql.NullInt64
	err := row.Scan(&t.ID, &t.Key, &t.ProjectID, &parent, &t.Kind, &t.Title, &t.Description, &t.State,
		&step, &stepSince, &skill, &lastStep, &workflow, &stepWorkflow, &aimed, &t.OwnerID, &rank, &t.Breakdown, &t.AutoComplete, &t.Acceptance,
		&fromRetro, &filedBy, &waiting, &created, &ended,
		&claimID, &holder, &session, &claimSkill, &version, &label,
		&timeout, &started, &expires, &t.Blocked)
	if err != nil {
		return t, err
	}
	t.ParentID, t.StepID, t.StepSince, t.SkillID = nullString(parent), nullString(step), nullTime(stepSince), nullString(skill)
	t.LastStepID, t.WorkflowID, t.StepWorkflowID = nullString(lastStep), nullString(workflow), nullString(stepWorkflow)
	t.AimedAtID, t.FromRetrospectiveTaskID, t.FiledBy = nullString(aimed), nullString(fromRetro), nullString(filedBy)
	if rank.Valid {
		t.Rank = &rank.Int64
	}
	t.WaitingSince, t.CreatedAt, t.EndedAt = fromMS(waiting), fromMS(created), nullTime(ended)
	t.Labels = []string{}
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
	id = shortid.Canonical(id) // either form (ADR 0017)
	m, err := scanMember(r.QueryRow(ctx, `SELECT `+memberCols+` FROM `+memberFrom+` WHERE m.org_id = $1 AND m.id = $2`, orgID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return m, refuse(CodeNotFound, "no Member %s", id)
	}
	return m, err
}

func getProject(ctx context.Context, r store.Reader, orgID, id string) (Project, error) {
	id = shortid.Canonical(id) // either form (ADR 0017)
	p, err := scanProject(r.QueryRow(ctx, `SELECT `+projectCols+` FROM projects pr WHERE pr.org_id = $1 AND pr.id = $2`, orgID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return p, refuse(CodeNotFound, "no Project %s", id)
	}
	return p, err
}

func getSkill(ctx context.Context, r store.Reader, orgID, id string) (Skill, error) {
	id = shortid.Canonical(id) // either form (ADR 0017)
	s, err := scanSkill(r.QueryRow(ctx, `SELECT `+skillCols+` FROM skills sk WHERE sk.org_id = $1 AND sk.id = $2`, orgID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return s, refuse(CodeNotFound, "no Skill %s", id)
	}
	return s, err
}

func getTask(ctx context.Context, r store.Reader, orgID, id string, now time.Time) (Task, error) {
	id = shortid.Canonical(id) // either form (ADR 0017)
	t, err := scanTask(r.QueryRow(ctx, `SELECT `+taskCols+` FROM `+taskFrom+` WHERE t.org_id = $1 AND t.id = $2`, orgID, id), now)
	if errors.Is(err, sql.ErrNoRows) {
		return t, refuse(CodeNotFound, "no Task %s", id)
	}
	if err != nil {
		return t, err
	}
	ts := []Task{t}
	err = fillTasks(ctx, r, orgID, now, ts)
	return ts[0], err
}

// fillTasks reads what each Task carries beside its row: its open blockers, Workspaces, Labels
// and Subtask counts, a query each.
func fillTasks(ctx context.Context, r store.Reader, orgID string, now time.Time, ts []Task) error {
	if len(ts) == 0 {
		return nil
	}
	if err := fillOpenBlockers(ctx, r, orgID, ts); err != nil {
		return err
	}
	if err := fillWorkspaceIDs(ctx, r, orgID, ts); err != nil {
		return err
	}
	if err := fillLabelIDs(ctx, r, orgID, ts); err != nil {
		return err
	}
	return fillSubtaskCounts(ctx, r, orgID, now, ts)
}

// taskMarks binds orgID and the ids of ts as $1, $2…, returning the placeholders of the ids and
// each id's place in ts.
func taskMarks(orgID string, ts []Task, extra ...any) (args []any, marks string, at map[string]int) {
	args = append([]any{orgID}, extra...)
	at = map[string]int{}
	ph := make([]string, len(ts))
	for i, t := range ts {
		args = append(args, t.ID)
		ph[i] = "$" + itoa(len(args))
		at[t.ID] = i
	}
	return args, strings.Join(ph, ", "), at
}

// fillWorkspaceIDs names the Workspaces each Task names, in the order named.
func fillWorkspaceIDs(ctx context.Context, r store.Reader, orgID string, ts []Task) error {
	args, marks, at := taskMarks(orgID, ts)
	rows, err := r.Query(ctx, `SELECT task_id, workspace_id FROM task_workspaces
WHERE org_id = $1 AND task_id IN (`+marks+`) ORDER BY task_id, position`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var task, ws string
		if err := rows.Scan(&task, &ws); err != nil {
			return err
		}
		i := at[task]
		ts[i].WorkspaceIDs = append(ts[i].WorkspaceIDs, ws)
	}
	return rows.Err()
}

// fillLabelIDs names the Labels each Task carries, by name.
func fillLabelIDs(ctx context.Context, r store.Reader, orgID string, ts []Task) error {
	args, marks, at := taskMarks(orgID, ts)
	rows, err := r.Query(ctx, `SELECT tl.task_id, l.id FROM task_labels tl JOIN labels l ON l.id = tl.label_id
WHERE tl.org_id = $1 AND tl.task_id IN (`+marks+`) ORDER BY tl.task_id, l.name, l.id`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var task, label string
		if err := rows.Scan(&task, &label); err != nil {
			return err
		}
		i := at[task]
		ts[i].Labels = append(ts[i].Labels, label)
	}
	return rows.Err()
}

// fillSubtaskCounts counts the Subtasks of each Task that has any.
func fillSubtaskCounts(ctx context.Context, r store.Reader, orgID string, now time.Time, ts []Task) error {
	args, marks, at := taskMarks(orgID, ts, ms(now))
	rows, err := r.Query(ctx, `SELECT parent_id,
SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END),
SUM(CASE WHEN state = 'open' AND claim_holder_id IS NOT NULL AND (claim_expires_at IS NULL OR claim_expires_at > $2) THEN 1 ELSE 0 END),
SUM(CASE WHEN state = 'done' THEN 1 ELSE 0 END),
SUM(CASE WHEN state = 'dropped' THEN 1 ELSE 0 END)
FROM tasks WHERE org_id = $1 AND parent_id IN (`+marks+`) GROUP BY parent_id`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var c SubtaskCounts
		if err := rows.Scan(&id, &c.Open, &c.Working, &c.Done, &c.Dropped); err != nil {
			return err
		}
		ts[at[id]].SubtaskCounts = &c
	}
	return rows.Err()
}

// fillOpenBlockers names the open blockers of each blocked Task.
func fillOpenBlockers(ctx context.Context, r store.Reader, orgID string, ts []Task) error {
	var blocked []Task
	for _, t := range ts {
		if t.Blocked {
			blocked = append(blocked, t)
		}
	}
	if len(blocked) == 0 {
		return nil
	}
	args, marks, _ := taskMarks(orgID, blocked)
	at := map[string]int{}
	for i, t := range ts {
		at[t.ID] = i
	}
	rows, err := r.Query(ctx, `SELECT b.task_id, bt.id, bt.display_key, bt.title FROM blocks b JOIN tasks bt ON bt.id = b.blocker_task_id
WHERE b.org_id = $1 AND bt.org_id = $1 AND bt.state = 'open' AND b.task_id IN (`+marks+`) ORDER BY bt.created_at, bt.id`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var task string
		var b TaskBrief
		if err := rows.Scan(&task, &b.ID, &b.Key, &b.Title); err != nil {
			return err
		}
		i := at[task]
		ts[i].OpenBlockers = append(ts[i].OpenBlockers, b)
	}
	return rows.Err()
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

// tasksWhere reads the Tasks of orgID matching where, which binds args; where may name the
// Task's Parent as pt, as the Rank order does.
func tasksWhere(ctx context.Context, r store.Reader, orgID string, now time.Time, where string, args ...any) ([]Task, error) {
	ts, err := collect(ctx, r, func(row interface{ Scan(...any) error }) (Task, error) { return scanTask(row, now) },
		`SELECT `+taskCols+` FROM `+taskFrom+` LEFT JOIN tasks pt ON pt.org_id = t.org_id AND pt.id = t.parent_id WHERE `+where, args...)
	if err != nil {
		return nil, err
	}
	return ts, fillTasks(ctx, r, orgID, now, ts)
}

// rankOrder sorts Tasks t, with their Parents pt, by Rank: a Subtask by its Parent's, after its
// Parent, the Subtasks of one Parent by how long each has waited.
const rankOrder = ` ORDER BY COALESCE(pt.rank, t.rank), t.project_id, COALESCE(t.parent_id, t.id),
CASE WHEN t.parent_id IS NULL THEN 0 ELSE 1 END, t.waiting_since, t.id`

func memberProjects(ctx context.Context, r store.Reader, orgID, memberID string) ([]Project, error) {
	return collect(ctx, r, scanProject, `SELECT `+projectCols+` FROM projects pr JOIN project_members x ON x.project_id = pr.id
WHERE pr.org_id = $1 AND x.member_id = $2 ORDER BY pr.name`, orgID, memberID)
}

func memberSkills(ctx context.Context, r store.Reader, orgID, memberID string) ([]Skill, error) {
	return collect(ctx, r, scanSkill, `SELECT `+skillCols+` FROM skills sk JOIN member_skills x ON x.skill_id = sk.id
WHERE sk.org_id = $1 AND x.member_id = $2 ORDER BY sk.name`, orgID, memberID)
}

func getMemberDetail(ctx context.Context, r store.Reader, orgID, id string) (MemberDetail, error) {
	id = shortid.Canonical(id) // either form (ADR 0017)
	var d MemberDetail
	var err error
	if d.Member, err = getMember(ctx, r, orgID, id); err != nil {
		return d, err
	}
	if d.Projects, err = memberProjects(ctx, r, orgID, id); err != nil {
		return d, err
	}
	if d.Skills, err = memberSkills(ctx, r, orgID, id); err != nil {
		return d, err
	}
	d.Reports, err = collect(ctx, r, scanMember, `SELECT `+memberCols+` FROM `+memberFrom+`
WHERE m.org_id = $1 AND r.manager_id = $2 ORDER BY m.name`, orgID, id)
	return d, err
}

func getProjectDetail(ctx context.Context, r store.Reader, orgID, id string) (ProjectDetail, error) {
	id = shortid.Canonical(id) // either form (ADR 0017)
	var d ProjectDetail
	var err error
	if d.Project, err = getProject(ctx, r, orgID, id); err != nil {
		return d, err
	}
	d.Members, err = collect(ctx, r, scanMember, `SELECT `+memberCols+` FROM `+memberFrom+`
JOIN project_members x ON x.member_id = m.id WHERE m.org_id = $1 AND x.project_id = $2 ORDER BY m.name`, orgID, id)
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
	id = shortid.Canonical(id) // either form (ADR 0017)
	var d SkillDetail
	var err error
	if d.Skill, err = getSkill(ctx, r, orgID, id); err != nil {
		return d, err
	}
	d.Current, err = getSkillVersion(ctx, r, orgID, id, d.Skill.CurrentVersion)
	return d, err
}

const evidenceCols = `e.id, e.task_id, e.filename, e.content_type, e.size, e.sha256, e.attached_by, e.created_at, e.blob_key`

func scanEvidence(row interface{ Scan(...any) error }) (Evidence, error) {
	var e Evidence
	var at int64
	err := row.Scan(&e.ID, &e.TaskID, &e.Filename, &e.ContentType, &e.Size, &e.SHA256, &e.AttachedBy, &at, &e.BlobKey)
	e.CreatedAt = fromMS(at)
	return e, err
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
	id = shortid.Canonical(id) // either form (ADR 0017)
	var d TaskDetail
	var err error
	if d.Task, err = getTask(ctx, r, orgID, id, now); err != nil {
		return d, err
	}
	if d.Task.ParentID != nil {
		var b TaskBrief
		if err := r.QueryRow(ctx, `SELECT id, display_key, title FROM tasks WHERE org_id = $1 AND id = $2`, orgID, *d.Task.ParentID).
			Scan(&b.ID, &b.Key, &b.Title); err != nil {
			return d, fmt.Errorf("core: the Parent of Task %s: %w", d.Task.Key, err)
		}
		d.Parent = &b
	}
	if d.Subtasks, err = tasksWhere(ctx, r, orgID, now, `t.org_id = $1 AND t.parent_id = $2 ORDER BY t.created_at, t.id`, orgID, id); err != nil {
		return d, err
	}
	d.Connectors = []Connector{}
	if d.Task.StepID != nil {
		st, err := getStep(ctx, r, orgID, *d.Task.StepID)
		if err != nil {
			return d, fmt.Errorf("core: the Step of Task %s: %w", d.Task.Key, err)
		}
		d.Step = &st
		if d.Connectors, err = connectorsFrom(ctx, r, orgID, st.ID); err != nil {
			return d, err
		}
	}
	if d.Labels, err = collect(ctx, r, scanLabel, `SELECT `+labelCols+` FROM labels l JOIN task_labels tl ON tl.label_id = l.id
WHERE tl.org_id = $1 AND tl.task_id = $2 ORDER BY l.name, l.id`, orgID, id); err != nil {
		return d, err
	}
	if d.Workspaces, err = collect(ctx, r, scanWorkspace, `SELECT `+workspaceCols+` FROM workspaces w
JOIN task_workspaces tw ON tw.workspace_id = w.id WHERE tw.org_id = $1 AND tw.task_id = $2 ORDER BY tw.position`, orgID, id); err != nil {
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
	if d.Blockers, err = tasksWhere(ctx, r, orgID, now, `t.org_id = $1 AND t.id IN (SELECT blocker_task_id FROM blocks WHERE org_id = $1 AND task_id = $2)
ORDER BY t.created_at, t.id`, orgID, id); err != nil {
		return d, err
	}
	if d.Blocking, err = tasksWhere(ctx, r, orgID, now, `t.org_id = $1 AND t.id IN (SELECT task_id FROM blocks WHERE org_id = $1 AND blocker_task_id = $2)
ORDER BY t.created_at, t.id`, orgID, id); err != nil {
		return d, err
	}
	if d.Observations, err = collect(ctx, r, scanObservation, `SELECT `+observationCols+`
FROM observations o WHERE o.org_id = $1 AND o.task_id = $2 ORDER BY o.created_at, o.id`, orgID, id); err != nil {
		return d, err
	}
	// The latest proposal for each Skill: no later one on the Task names the same Skill.
	if d.Proposals, err = collect(ctx, r, scanProposal, `SELECT `+proposalCols+` FROM skill_proposals p
WHERE p.org_id = $1 AND p.task_id = $2 AND NOT EXISTS (SELECT 1 FROM skill_proposals q WHERE q.org_id = p.org_id AND q.task_id = p.task_id
	AND q.skill_id = p.skill_id AND (q.created_at > p.created_at OR (q.created_at = p.created_at AND q.id > p.id)))
ORDER BY p.created_at, p.id`, orgID, id); err != nil {
		return d, err
	}
	return d, nil
}

const observationCols = `o.id, o.task_id, o.author_id, o.skill_id, o.outcome, o.body, o.created_at,
o.reviewed_by_task_id, o.reviewed_at`

func scanObservation(row interface{ Scan(...any) error }) (Observation, error) {
	var o Observation
	var skill, reviewedBy sql.NullString
	var at int64
	var reviewedAt sql.NullInt64
	err := row.Scan(&o.ID, &o.TaskID, &o.AuthorID, &skill, &o.Outcome, &o.Body, &at, &reviewedBy, &reviewedAt)
	o.SkillID, o.CreatedAt, o.ReviewedByTaskID, o.ReviewedAt = nullString(skill), fromMS(at), nullString(reviewedBy), nullTime(reviewedAt)
	return o, err
}

const proposalCols = `p.id, p.skill_id, p.task_id, p.based_on_version, p.body, p.author_id, p.state, p.published_version,
p.created_at, p.decided_at`

func scanProposal(row interface{ Scan(...any) error }) (SkillProposal, error) {
	var p SkillProposal
	var published, decided sql.NullInt64
	var created int64
	err := row.Scan(&p.ID, &p.SkillID, &p.TaskID, &p.BasedOnVersion, &p.Body, &p.AuthorID, &p.State, &published, &created, &decided)
	if published.Valid {
		p.PublishedVersion = &published.Int64
	}
	p.CreatedAt, p.DecidedAt = fromMS(created), nullTime(decided)
	return p, err
}

func getProposal(ctx context.Context, r store.Reader, orgID, id string) (SkillProposal, error) {
	id = shortid.Canonical(id) // either form (ADR 0017)
	p, err := scanProposal(r.QueryRow(ctx, `SELECT `+proposalCols+` FROM skill_proposals p WHERE p.org_id = $1 AND p.id = $2`, orgID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return p, refuse(CodeNotFound, "no Skill proposal %s", id)
	}
	return p, err
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
	a.SubjectType, _, _ = strings.Cut(a.Kind, ".")
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
