package core

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/tuongaz/darkory/internal/auth"
)

func validTitle(title string) error {
	if strings.TrimSpace(title) == "" || utf8.RuneCountInString(title) > 200 {
		return refuse(CodeInvalid, "a title is 1 to 200 characters")
	}
	return nil
}

// NewTask is a Task to file: in Project, or as a Subtask under Parent, or beside the Task it
// Blocks (a question or an Escalation). It is aimed at a Member, or at a Step — the one named, or
// by default the Workflow's first Step for the Project's own work (defaultStep) — or, with Break
// down on, a Parent from its first moment.
type NewTask struct {
	Project     *string
	Parent      *string
	Title       string
	Description string
	// Owner defaults to the filer; a Subtask's is its Parent's.
	Owner *string
	// Step names the Step it starts at, by id or name.
	Step *string
	// Breakdown files its Breakdown Subtask with it, at the Workflow's breakdown Step.
	Breakdown bool
	// AutoComplete and Acceptance are nil for the Project's defaults; they are a Parent's.
	AutoComplete *bool
	Acceptance   *bool
	// Labels names Labels of the Project or the Organisation, by id or name.
	Labels []string
	// Workspaces names the Workspaces it names, in order; nil for its Parent's, or its Project's
	// default when it has no Parent; an empty list for none.
	Workspaces *[]string
	AimedAt    *string
	// Blocks names a Task the new one blocks: it joins that Task's Parent, or stands alone in its
	// Project beside a Task with none, and blocks it in the same write; the asker keeps their
	// Claim.
	Blocks *string
	// Note is written on the Parent when filing a Subtask under a Task the filer holds, whose
	// Claim the filing ends.
	Note *string
	// FromRetrospective names the Retrospective whose findings the Task is.
	FromRetrospective *string
}

func (nt NewTask) validate() error {
	if err := validTitle(nt.Title); err != nil {
		return err
	}
	switch {
	case nt.Project == nil && nt.Parent == nil && nt.Blocks == nil:
		return refuse(CodeInvalid, "name the Project the Task is filed in, its Parent, or the Task it blocks")
	case nt.AimedAt != nil && nt.Step != nil:
		return refuse(CodeInvalid, "a Task aimed at a Member waits with them, at no Step; name a Step or a Member, not both")
	case nt.Breakdown && (nt.Parent != nil || nt.Blocks != nil):
		return refuse(CodeInvalid, "a Subtask has no Subtasks of its own, so it cannot be broken down")
	case nt.Breakdown && (nt.AimedAt != nil || nt.Step != nil):
		return refuse(CodeInvalid, "a Task filed with Break down is a Parent, at no Step and aimed at no one")
	case nt.Parent != nil && nt.Owner != nil:
		return refuse(CodeUseParent, "a Subtask's Owner is its Parent's; pass the Parent's ownership instead")
	case nt.Parent != nil && (nt.AutoComplete != nil || nt.Acceptance != nil):
		return refuse(CodeInvalid, "auto_complete and acceptance are a Parent's, and a Subtask has no Subtasks")
	case nt.Note != nil && nt.Parent == nil:
		return refuse(CodeInvalid, "a Note goes on the Parent whose Claim filing a Subtask ends; name the parent")
	case nt.FromRetrospective != nil && (nt.Parent != nil || nt.Blocks != nil):
		return refuse(CodeInvalid, "a Retrospective files new Tasks in the Project, not under a Parent")
	}
	return nil
}

// FileTask files a Task. A Task with no Parent goes to the bottom of its Project's Rank, owned by
// the filer unless another is named; the filer must be in the Project. A Subtask (one level: its
// Parent has no Parent of its own) inherits its Parent's Project and Owner; anyone in the Project
// or the Owner may file one under a Task nobody holds, and the holder under the Task they hold,
// which ends their Claim split. The first Subtask makes the Task a Parent, at no Step. A Task that
// blocks another — a question or an Escalation — joins that Task's Parent, even an ended one, or
// stands alone beside a Task with none, and blocks it in the same write. A Task filed with Break
// down is a Parent from its first moment, its Breakdown Subtask filed at the Workflow's breakdown
// Step (refused no_step when it has none).
func (s *Service) FileTask(ctx context.Context, c *auth.Caller, nt NewTask, idem Idem) (TaskDetail, error) {
	if err := nt.validate(); err != nil {
		return TaskDetail{}, err
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		var parent, blocked *Task
		projectID := ""
		if nt.Blocks != nil {
			b, err := taskOf(t, *nt.Blocks)
			if err != nil {
				return nil, err
			}
			if b.State != "open" {
				return nil, refuse(CodeEnded, "Task %s is %s; a question blocks an open Task", b.Key, b.State)
			}
			if b.SubtaskCounts != nil {
				return nil, refuse(CodeConflict, "%s is a Parent, and a Parent is never blocked: ask about one of its Subtasks", b.Key)
			}
			if err := mayBlock(ctx, t, c, b); err != nil {
				return nil, err
			}
			blocked, projectID = &b, b.ProjectID
			if b.ParentID != nil {
				p, err := getTask(ctx, t, c.OrgID, *b.ParentID, t.now)
				if err != nil {
					return nil, err
				}
				parent = &p
			}
		}
		if nt.Parent != nil {
			p, err := taskOf(t, *nt.Parent)
			if err != nil {
				return nil, err
			}
			if blocked != nil && (parent == nil || parent.ID != p.ID) {
				return nil, refuse(CodeInvalid, "a Task that blocks %s joins %s's Parent; leave parent out", blocked.Key, blocked.Key)
			}
			if blocked == nil {
				if err := mayFileUnder(ctx, t, c, p); err != nil {
					return nil, err
				}
				if p.Claim == nil && nt.Note != nil && *nt.Note != "" {
					return nil, refuse(CodeInvalid, "nobody holds %s, so no Claim ends to leave a Note about", p.Key)
				}
			}
			parent, projectID = &p, p.ProjectID
		}
		if nt.Project != nil {
			id, err := resolveProject(ctx, t, c.OrgID, *nt.Project)
			if err != nil {
				return nil, err
			}
			if projectID != "" && id != projectID {
				return nil, refuse(CodeInvalid, "the Task joins Project %s with the Task it is filed under or blocks; leave project out", projectID)
			}
			projectID = id
		}
		project, err := getProject(ctx, t, c.OrgID, projectID)
		if err != nil {
			return nil, err
		}
		if parent == nil && blocked == nil {
			in, err := inProject(ctx, t, c.OrgID, projectID, c.MemberID)
			if err != nil {
				return nil, err
			}
			if !in {
				return nil, refuse(CodeForbidden, "only a Member of Project %s may file a Task in it", project.Key)
			}
		}

		row := taskRow{projectID: projectID, kind: "work", title: nt.Title, description: nt.Description, filedBy: &c.MemberID,
			breakdown: nt.Breakdown}
		if parent != nil {
			row.parentID, row.ownerID = &parent.ID, parent.OwnerID
		} else {
			row.ownerID = c.MemberID
			if nt.Owner != nil {
				if row.ownerID, err = resolveMember(ctx, t, c.OrgID, *nt.Owner); err != nil {
					return nil, err
				}
			}
			row.autoComplete, row.acceptance = project.AutoComplete, project.Acceptance
			if nt.AutoComplete != nil {
				row.autoComplete = *nt.AutoComplete
			}
			if nt.Acceptance != nil {
				row.acceptance = *nt.Acceptance
			}
		}
		if nt.FromRetrospective != nil {
			r, err := taskOf(t, *nt.FromRetrospective)
			if err != nil {
				return nil, err
			}
			if r.Kind != "retrospective" {
				return nil, refuse(CodeInvalid, "%s is not a Retrospective", r.Key)
			}
			row.fromRetro = &r.ID
		}
		w, err := getWorkflow(ctx, t, c.OrgID, projectID)
		if err != nil {
			return nil, err
		}
		var breakdownStep *Step
		switch {
		case nt.Breakdown:
			if breakdownStep, err = builtinStep(ctx, t, c.OrgID, projectID, SkillBreakdown); err != nil {
				return nil, err
			}
			if breakdownStep == nil {
				return nil, refuse(CodeNoStep, "Project %s's Workflow has no Step carrying breakdown, so it offers no Break down", project.Key)
			}
		case nt.AimedAt != nil:
			id, err := resolveMember(ctx, t, c.OrgID, *nt.AimedAt)
			if err != nil {
				return nil, err
			}
			row.aimedAt = &id
		case nt.Step != nil:
			st, ok := w.find(*nt.Step)
			if !ok {
				return nil, refuse(CodeNotFound, "Project %s's Workflow has no Step %q", project.Key, *nt.Step)
			}
			row.stepID = &st.ID
		default:
			builtin, err := builtinSkills(ctx, t, c.OrgID)
			if err != nil {
				return nil, err
			}
			st := defaultStep(w, builtin)
			if st == nil {
				return nil, refuse(CodeNoStep, "Project %s's Workflow has no Steps for a Task to stand at", project.Key)
			}
			row.stepID = &st.ID
		}
		labels, err := taskLabels(t, projectID, nt.Labels)
		if err != nil {
			return nil, err
		}
		// A Subtask named no Workspaces works in its Parent's: its branch starts from the Parent's.
		var workspaces []string
		if parent != nil && nt.Workspaces == nil {
			workspaces = parent.WorkspaceIDs
		} else if workspaces, err = taskWorkspaces(t, projectID, nt.Workspaces); err != nil {
			return nil, err
		}

		// A Task becomes a Parent with its first Subtask; its holder's split ends their Claim.
		if parent != nil && blocked == nil {
			if err := becomeParent(t, *parent, nt.Note); err != nil {
				return nil, err
			}
		}
		id, key, err := insertTask(t, row)
		if err != nil {
			return nil, err
		}
		if err := nameWorkspaces(t, id, workspaces); err != nil {
			return nil, err
		}
		if err := labelTask(t, id, labels); err != nil {
			return nil, err
		}
		payload := map[string]any{"key": key, "title": nt.Title, "project_id": projectID, "kind": "work", "owner_id": row.ownerID}
		if row.parentID != nil {
			payload["parent_id"] = *row.parentID
		} else {
			payload["auto_complete"], payload["acceptance"] = row.autoComplete, row.acceptance
		}
		if nt.Breakdown {
			payload["breakdown"] = true
		}
		if row.stepID != nil {
			payload["step_id"] = *row.stepID
		}
		if row.aimedAt != nil {
			payload["aimed_at_id"] = *row.aimedAt
		}
		if len(labels) > 0 {
			payload["labels"] = labels
		}
		if blocked != nil {
			payload["blocks"] = blocked.ID
		}
		if row.fromRetro != nil {
			payload["from_retrospective_task_id"] = *row.fromRetro
		}
		if err := t.recordByCaller("task.filed", id, payload); err != nil {
			return nil, err
		}
		if breakdownStep != nil {
			filed, err := getTask(ctx, t, c.OrgID, id, t.now)
			if err != nil {
				return nil, err
			}
			if _, err := fileOwnSubtask(t, filed, "breakdown", "Break down: "+nt.Title, *breakdownStep); err != nil {
				return nil, err
			}
		}
		if blocked != nil {
			if _, err := t.Exec(ctx, `INSERT INTO blocks (org_id, task_id, blocker_task_id, added_by, added_at) VALUES ($1, $2, $3, $4, $5)`,
				c.OrgID, blocked.ID, id, c.MemberID, ms(t.now)); err != nil {
				return nil, err
			}
			if err := t.recordByCaller("task.blocker_added", blocked.ID, map[string]any{"blocker_id": id, "blocker_key": key}); err != nil {
				return nil, err
			}
		}
		return getTaskDetail(ctx, t, c.OrgID, id, t.now)
	})
	if err != nil {
		return TaskDetail{}, err
	}
	return res.(TaskDetail), nil
}

// mayFileUnder refuses filing a Subtask under p by the caller: p must be open and have no Parent
// itself (one_level), and neither block nor be blocked, since a Parent does neither; under a held
// Task only its holder may file, else anyone in its Project or its Owner.
func mayFileUnder(ctx context.Context, t *tx, c *auth.Caller, p Task) error {
	switch {
	case p.ParentID != nil:
		return refuse(CodeOneLevel, "%s is a Subtask, and a Subtask has no Subtasks of its own: file beside it, under its Parent", p.Key)
	case p.State != "open":
		return refuse(CodeEnded, "Task %s is %s; a Subtask is filed under an open Task", p.Key, p.State)
	case p.Claim != nil && p.Claim.HolderID != c.MemberID:
		return refuse(CodeHeld, "Task %s is held by another Member; only its holder may file a Subtask under it", p.Key)
	case p.Claim != nil:
		if err := holds(c, p); err != nil {
			return err
		}
	default:
		if err := inProjectOrOwner(ctx, t, c, p, "file a Subtask under"); err != nil {
			return err
		}
	}
	if p.SubtaskCounts != nil {
		return nil
	}
	var n int
	if err := t.QueryRow(ctx, `SELECT COUNT(*) FROM blocks b JOIN tasks x ON x.org_id = b.org_id
	AND x.id = CASE WHEN b.task_id = $2 THEN b.blocker_task_id ELSE b.task_id END
WHERE b.org_id = $1 AND (b.task_id = $2 OR b.blocker_task_id = $2) AND x.state = 'open'`, c.OrgID, p.ID).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return refuse(CodeConflict, "%s blocks or is blocked by an open Task, and a Parent neither blocks nor is blocked: remove the Blocking first", p.Key)
	}
	return nil
}

// becomeParent makes p a Parent inside a write, when it is not one yet: at no Step and aimed at
// no one. Its holder's Claim ends split, with their Note (task.split); one that had already run
// out is recorded as lapsed. task.became_parent records the Step it left. FileTask has refused a
// Note when nobody holds p.
func becomeParent(t *tx, p Task, note *string) error {
	if p.SubtaskCounts != nil {
		return nil
	}
	claim, holder, live, err := endClaimOf(t, p.ID, "split")
	if err != nil {
		return err
	}
	if live {
		if note != nil && *note != "" {
			if err := addNote(t, p.ID, p.Claim.SkillID, *note); err != nil {
				return err
			}
		}
		if err := t.recordByCaller("task.split", p.ID, map[string]any{"claim_id": claim, "holder_id": holder}); err != nil {
			return err
		}
	}
	if _, err := t.Exec(t.ctx, `UPDATE tasks SET step_id = NULL, step_since = NULL, aimed_at_id = NULL WHERE org_id = $1 AND id = $2`,
		t.caller.OrgID, p.ID); err != nil {
		return err
	}
	payload := map[string]any{}
	if p.StepID != nil {
		payload["from"] = *p.StepID
		if p.StepSince != nil {
			payload["since"] = ms(*p.StepSince)
		}
	}
	return t.recordByCaller("task.became_parent", p.ID, payload)
}

// taskRow is a Task to insert.
type taskRow struct {
	projectID                            string
	parentID, stepID, aimedAt, fromRetro *string
	kind, title, description, ownerID    string
	filedBy                              *string
	breakdown, autoComplete, acceptance  bool
}

// insertTask files an open Task, allocating its display key from its Project's counter; one with
// no Parent goes to the bottom of the Project's Rank.
func insertTask(t *tx, r taskRow) (id, key string, err error) {
	var prefix string
	var last int64
	if err := t.QueryRow(t.ctx, `UPDATE projects SET last_number = last_number + 1 WHERE org_id = $1 AND id = $2 RETURNING key_prefix, last_number`,
		t.caller.OrgID, r.projectID).Scan(&prefix, &last); err != nil {
		return "", "", err
	}
	var rank *int64
	if r.parentID == nil {
		var n int64
		if err := t.QueryRow(t.ctx, `SELECT COALESCE(MAX(rank), 0) + 1 FROM tasks WHERE org_id = $1 AND project_id = $2 AND parent_id IS NULL`,
			t.caller.OrgID, r.projectID).Scan(&n); err != nil {
			return "", "", err
		}
		rank = &n
	}
	var since *int64
	if r.stepID != nil {
		since = ptr(ms(t.now))
	}
	id, key = newID(), prefix+"-"+itoa64(last)
	_, err = t.Exec(t.ctx, `INSERT INTO tasks (id, org_id, project_id, parent_id, display_key, kind, title, description, state, step_id,
step_since, aimed_at_id, owner_id, rank, breakdown, auto_complete, acceptance, from_retrospective_task_id, filed_by, waiting_since, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $19)`,
		id, t.caller.OrgID, r.projectID, r.parentID, key, r.kind, r.title, r.description, r.stepID, since, r.aimedAt, r.ownerID, rank,
		r.breakdown, r.autoComplete, r.acceptance, r.fromRetro, r.filedBy, ms(t.now))
	return id, key, err
}

// fileOwnSubtask files, inside a write, a Subtask Darkory owns about parent as a whole — its
// Breakdown, Acceptance or Retrospective — at step: filed by nobody, owned by the Parent's Owner,
// naming the Parent's Workspaces, and recorded with no actor.
func fileOwnSubtask(t *tx, parent Task, kind, title string, step Step) (string, error) {
	id, key, err := insertTask(t, taskRow{projectID: parent.ProjectID, parentID: &parent.ID, kind: kind, title: title,
		ownerID: parent.OwnerID, stepID: &step.ID})
	if err != nil {
		return "", err
	}
	if err := nameWorkspaces(t, id, parent.WorkspaceIDs); err != nil {
		return "", err
	}
	return id, t.record(nil, "task.filed", id, map[string]any{"key": key, "title": title, "kind": kind, "parent_id": parent.ID,
		"owner_id": parent.OwnerID, "step_id": step.ID})
}

// fileRetrospective files the Retrospective of a Parent that has just ended, at its Workflow's
// retro Step; a Workflow with none files none (ADR 0010).
func fileRetrospective(t *tx, parent Task) error {
	st, err := builtinStep(t.ctx, t, t.caller.OrgID, parent.ProjectID, SkillRetro)
	if err != nil || st == nil {
		return err
	}
	_, err = fileOwnSubtask(t, parent, "retrospective", "Retrospective: "+parent.Title, *st)
	return err
}

// taskOf reads the Task ref names inside a write.
func taskOf(t *tx, ref string) (Task, error) {
	id, err := resolveTask(t.ctx, t, t.caller.OrgID, ref)
	if err != nil {
		return Task{}, err
	}
	return getTask(t.ctx, t, t.caller.OrgID, id, t.now)
}

// inProjectOrOwner refuses a caller who is neither a Member of the Task's Project nor its Owner.
func inProjectOrOwner(ctx context.Context, r storeReader, c *auth.Caller, task Task, verb string) error {
	if task.OwnerID == c.MemberID {
		return nil
	}
	in, err := inProject(ctx, r, c.OrgID, task.ProjectID, c.MemberID)
	if err != nil {
		return err
	}
	if !in {
		return refuse(CodeForbidden, "only a Member of its Project or its Owner may %s %s", verb, task.Key)
	}
	return nil
}

// GetTask returns a Task with its Parent, Subtasks, Step, Claims, Notes, Evidence, blockers and
// Observations.
func (s *Service) GetTask(ctx context.Context, c *auth.Caller, ref string) (TaskDetail, error) {
	id, err := resolveTask(ctx, s.store, c.OrgID, ref)
	if err != nil {
		return TaskDetail{}, err
	}
	return getTaskDetail(ctx, s.store, c.OrgID, id, s.clock.Now())
}

// TaskFilter narrows ListTasks; nil fields do not. Step names a Step by id, or by name with
// Project, since names are unique only within a Project's Workflow. Filters are `filter` tokens
// (filter.go), where the Step's Skill is `skill`; SessionTasks are the ids of the Tasks a Runner
// beside the server runs a session for now, which `claim:is:session` matches.
type TaskFilter struct {
	Project, Parent, State, Step, AimedAt, Holder *string
	Filters                                       []string
	SessionTasks                                  []string
	Limit                                         int
	Cursor                                        string
}

// ListTasks lists Tasks by Rank: a Subtask after its Parent, by how long each has waited.
func (s *Service) ListTasks(ctx context.Context, c *auth.Caller, tf TaskFilter) (Page[Task], error) {
	offset, err := decodeCursor(tf.Cursor)
	if err != nil {
		return Page[Task]{}, err
	}
	filters, err := parseFilters(EntityTasks, tf.Filters)
	if err != nil {
		return Page[Task]{}, err
	}
	limit := limitOf(tf.Limit)
	now := s.clock.Now()
	q := &sqlQuery{now: now, sessions: tf.SessionTasks}
	q.and("t.org_id = " + q.arg(c.OrgID))
	refs := []struct {
		ref     *string
		resolve func(context.Context, storeReader, string, string) (string, error)
		col     string
	}{
		{tf.Project, resolveProject, "t.project_id"},
		{tf.Parent, resolveTask, "t.parent_id"},
		{tf.AimedAt, resolveMember, "t.aimed_at_id"},
		{tf.Holder, resolveMember, "t.claim_holder_id"},
	}
	for _, r := range refs {
		if r.ref == nil {
			continue
		}
		id, err := r.resolve(ctx, s.store, c.OrgID, *r.ref)
		if err != nil {
			return Page[Task]{}, err
		}
		q.and(r.col + " = " + q.arg(id))
	}
	if tf.Holder != nil {
		q.and("(t.claim_expires_at IS NULL OR t.claim_expires_at > " + q.nowArg() + ")")
	}
	if tf.Step != nil {
		var st Step
		if tf.Project == nil {
			if st, err = getStep(ctx, s.store, c.OrgID, *tf.Step); codeOf(err) == CodeNotFound {
				return Page[Task]{}, refuse(CodeInvalid, "no Step has the id %q; a Step named by its name needs the project too", *tf.Step)
			}
		} else {
			projectID, rerr := resolveProject(ctx, s.store, c.OrgID, *tf.Project)
			if rerr != nil {
				return Page[Task]{}, rerr
			}
			st, err = stepOf(ctx, s.store, c.OrgID, projectID, *tf.Step)
		}
		if err != nil {
			return Page[Task]{}, err
		}
		q.and("t.step_id = " + q.arg(st.ID))
	}
	if tf.State != nil {
		q.and("t.state = " + q.arg(*tf.State))
	}
	q.narrow(filters)
	items, err := tasksWhere(ctx, s.store, c.OrgID, now, q.sql()+rankOrder+` LIMIT `+q.arg(limit+1)+` OFFSET `+q.arg(offset), q.args...)
	if err != nil {
		return Page[Task]{}, err
	}
	return page(items, offset, limit), nil
}

// RankTask moves a Task with no Parent to position within its Project's Rank, 1 first; a
// position past the end moves it last. Ended Tasks keep their places and count as positions (ADR
// 0010). A Subtask sorts by its Parent's (use_parent). By a Member of the Project or the Owner.
func (s *Service) RankTask(ctx context.Context, c *auth.Caller, ref string, position int64, idem Idem) (Task, error) {
	if position < 1 {
		return Task{}, refuse(CodeInvalid, "position is 1 or more")
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		task, err := taskOf(t, ref)
		if err != nil {
			return nil, err
		}
		if task.ParentID != nil {
			return nil, refuse(CodeUseParent, "%s is a Subtask and sorts by its Parent's Rank; rank the Parent", task.Key)
		}
		if err := inProjectOrOwner(ctx, t, c, task, "rank"); err != nil {
			return nil, err
		}
		var n int64
		if err := t.QueryRow(ctx, `SELECT COUNT(*) FROM tasks WHERE org_id = $1 AND project_id = $2 AND parent_id IS NULL`,
			c.OrgID, task.ProjectID).Scan(&n); err != nil {
			return nil, err
		}
		to, from := min(position, n), *task.Rank
		if to == from {
			return task, nil
		}
		// Positions are 1…n; the Tasks between the two places each move one step.
		shift := `UPDATE tasks SET rank = rank - 1 WHERE org_id = $1 AND project_id = $2 AND parent_id IS NULL AND rank > $3 AND rank <= $4`
		lo, hi := from, to
		if to < from {
			shift = `UPDATE tasks SET rank = rank + 1 WHERE org_id = $1 AND project_id = $2 AND parent_id IS NULL AND rank >= $3 AND rank < $4`
			lo, hi = to, from
		}
		if _, err := t.Exec(ctx, shift, c.OrgID, task.ProjectID, lo, hi); err != nil {
			return nil, err
		}
		if _, err := t.Exec(ctx, `UPDATE tasks SET rank = $1 WHERE org_id = $2 AND id = $3`, to, c.OrgID, task.ID); err != nil {
			return nil, err
		}
		if err := t.recordByCaller("task.ranked", task.ID, map[string]any{"from": from, "to": to}); err != nil {
			return nil, err
		}
		return getTask(ctx, t, c.OrgID, task.ID, t.now)
	})
	if err != nil {
		return Task{}, err
	}
	return res.(Task), nil
}

// PassOwnership makes another Member the Owner of a Task with no Parent and of its Subtasks, in
// one write: by the Owner, or by someone above the Owner on their Reporting line (decisions.md).
// A Subtask's Owner is its Parent's (use_parent).
func (s *Service) PassOwnership(ctx context.Context, c *auth.Caller, ref, ownerRef string, idem Idem) (Task, error) {
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		task, err := taskOf(t, ref)
		if err != nil {
			return nil, err
		}
		if task.ParentID != nil {
			return nil, refuse(CodeUseParent, "%s is a Subtask, whose Owner is its Parent's; pass the Parent's ownership", task.Key)
		}
		if task.OwnerID != c.MemberID {
			above, err := onReportingLine(ctx, t, c.OrgID, task.OwnerID, c.MemberID)
			if err != nil {
				return nil, err
			}
			if !above {
				return nil, refuse(CodeForbidden, "only the Owner of %s, or someone above them on their Reporting line, may pass it on", task.Key)
			}
		}
		owner, err := resolveMember(ctx, t, c.OrgID, ownerRef)
		if err != nil {
			return nil, err
		}
		if owner == task.OwnerID {
			return task, nil
		}
		if _, err := t.Exec(ctx, `UPDATE tasks SET owner_id = $1 WHERE org_id = $2 AND (id = $3 OR parent_id = $3)`, owner, c.OrgID, task.ID); err != nil {
			return nil, err
		}
		if err := t.recordByCaller("task.owner_passed", task.ID, map[string]any{"from": task.OwnerID, "to": owner}); err != nil {
			return nil, err
		}
		return getTask(ctx, t, c.OrgID, task.ID, t.now)
	})
	if err != nil {
		return Task{}, err
	}
	return res.(Task), nil
}
