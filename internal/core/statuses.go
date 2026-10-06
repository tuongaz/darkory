package core

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/store"
)

// Statuses: where a Task is in its workflow, from the one list each Organisation defines and
// orders (ADR 0012). The rules read a Status's kind, never its name: a backlog Task is not
// takeable, and done and dropped are reached only by Complete and Drop, never left. Darkory moves
// the Status on its own acts inside the writes that make them, so the hot paths keep their one
// statement and one round trip.

// The Status kinds.
const (
	KindBacklog    = "backlog"
	KindTodo       = "todo"
	KindInProgress = "in_progress"
	KindDone       = "done"
	KindDropped    = "dropped"
)

var statusKinds = []string{KindBacklog, KindTodo, KindInProgress, KindDone, KindDropped}

// defaultStatuses are the list `darkory init` gives a new Organisation, and migration 0003 gave
// every Organisation that existed before it.
var defaultStatuses = []struct{ name, kind string }{
	{"Backlog", KindBacklog},
	{"Todo", KindTodo},
	{"In progress", KindInProgress},
	{"In review", KindInProgress},
	{"Done", KindDone},
	{"Dropped", KindDropped},
}

// ending names how a kind ends a Task: open kinds hold open Tasks, done and dropped the Tasks
// that ended so. A Task never changes ending through its Status.
func ending(kind string) string {
	switch kind {
	case KindDone, KindDropped:
		return kind
	}
	return "open"
}

// firstStatusSQL is the id of the first Status of kind in the Organisation org (an SQL
// expression), in list order.
func firstStatusSQL(org, kind string) string {
	return `(SELECT fs.id FROM statuses fs WHERE fs.org_id = ` + org + ` AND fs.kind = '` + kind + `' ORDER BY fs.position, fs.id LIMIT 1)`
}

// releaseStatusSQL is the SET clause, after clearClaimSQL, that returns a Task in an in_progress
// Status to the first todo one: a Claim that ends any way but Handover, Complete or Drop leaves no
// one working it, so it should not read as in progress (ADR 0012).
var releaseStatusSQL = `, status_id = CASE WHEN EXISTS (SELECT 1 FROM statuses rs WHERE rs.org_id = tasks.org_id
	AND rs.id = tasks.status_id AND rs.kind = 'in_progress')
THEN COALESCE(` + firstStatusSQL("tasks.org_id", KindTodo) + `, tasks.status_id) ELSE tasks.status_id END`

// claimStatusSQL is the new status_id of a Task t a claim takes: a todo Task moves to the first
// in_progress Status, any other stays where it is. A lapsed Claim's Task is still in progress and
// stays so.
var claimStatusSQL = `CASE WHEN EXISTS (SELECT 1 FROM statuses cst WHERE cst.org_id = @org AND cst.id = t.status_id AND cst.kind = 'todo')
THEN COALESCE(` + firstStatusSQL("@org", KindInProgress) + `, t.status_id) ELSE t.status_id END`

// statusGuard holds while the Task @task is in the Status @status: a hot-path write that sent its
// response before the batch checks that the Status it named is the one the write left.
const statusGuard = `SELECT 1 / COUNT(*) FROM tasks t WHERE t.org_id = @org AND t.id = @task AND t.status_id = @status`

// statuses is an Organisation's list, in order.
type statuses []Status

func listStatuses(ctx context.Context, r store.Reader, orgID string) (statuses, error) {
	return collect(ctx, r, scanStatus, `SELECT id, name, kind, position FROM statuses WHERE org_id = $1 ORDER BY position, id`, orgID)
}

func scanStatus(row interface{ Scan(...any) error }) (Status, error) {
	var s Status
	err := row.Scan(&s.ID, &s.Name, &s.Kind, &s.Position)
	return s, err
}

// first is the first Status of kind.
func (ss statuses) first(kind string) Status {
	for _, s := range ss {
		if s.Kind == kind {
			return s
		}
	}
	return Status{}
}

func (ss statuses) byID(id string) (Status, bool) {
	for _, s := range ss {
		if s.ID == id {
			return s, true
		}
	}
	return Status{}, false
}

// find resolves a reference to a Status: its id, or its name in any case, since names are unique
// ignoring case. It matches in Go rather than SQL, whose lower() differs between the engines.
func (ss statuses) find(ref string) (Status, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return Status{}, refuse(CodeInvalid, "a Status reference is empty")
	}
	if s, ok := ss.byID(ref); ok {
		return s, nil
	}
	for _, s := range ss {
		if strings.EqualFold(s.Name, ref) {
			return s, nil
		}
	}
	return Status{}, refuse(CodeNotFound, "no Status %q", ref)
}

// afterClaim is the Status a claim leaves a Task in that was in id.
func (ss statuses) afterClaim(id string) Status {
	s, _ := ss.byID(id)
	if s.Kind == KindTodo {
		if next := ss.first(KindInProgress); next.ID != "" {
			return next
		}
	}
	return s
}

// afterRelease is the Status a Claim ending any way but Handover, Complete or Drop leaves a Task in
// that was in id.
func (ss statuses) afterRelease(id string) Status {
	s, _ := ss.byID(id)
	if s.Kind == KindInProgress {
		if next := ss.first(KindTodo); next.ID != "" {
			return next
		}
	}
	return s
}

// openStatus resolves ref to a Status a Member may name: one of an open kind. Done and dropped are
// reached by completing and dropping the Task.
func (ss statuses) openStatus(ref string) (Status, error) {
	s, err := ss.find(ref)
	if err != nil {
		return s, err
	}
	switch s.Kind {
	case KindDone:
		return s, refuse(CodeUseComplete, "%s is a done Status; a Task gets there only by being completed by its holder", s.Name)
	case KindDropped:
		return s, refuse(CodeUseDrop, "%s is a dropped Status; a Task gets there only by being dropped by its Feature's owner", s.Name)
	}
	return s, nil
}

func getStatus(ctx context.Context, r store.Reader, orgID, id string) (Status, error) {
	return scanStatus(r.QueryRow(ctx, `SELECT id, name, kind, position FROM statuses WHERE org_id = $1 AND id = $2`, orgID, id))
}

// seedStatuses gives a new Organisation the default list.
func seedStatuses(t *tx) error {
	for i, d := range defaultStatuses {
		if _, err := t.Exec(t.ctx, `INSERT INTO statuses (id, org_id, name, kind, position, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
			newID(), t.caller.OrgID, d.name, d.kind, i+1, ms(t.now)); err != nil {
			return err
		}
	}
	return nil
}

// ListStatuses lists the caller's Organisation's Statuses, in order.
func (s *Service) ListStatuses(ctx context.Context, c *auth.Caller) ([]Status, error) {
	return listStatuses(ctx, s.store, c.OrgID)
}

// StatusInput is one Status of the list an admin sets: ID names one in the list now, and is empty
// for a new one.
type StatusInput struct {
	ID   string
	Name string
	Kind string
}

// SetStatuses replaces the Organisation's list of Statuses with items, in their order (admin). A
// Status left out is deleted; the Tasks in it go where moves says (deleted id → kept id). The list
// keeps a todo, in_progress, done and dropped kind, and no Task changes how it ended: a move, or a
// change of kind on a Status Tasks are in, stays within the open kinds, done or dropped.
func (s *Service) SetStatuses(ctx context.Context, c *auth.Caller, items []StatusInput, moves map[string]string, idem Idem) ([]Status, error) {
	if err := mustAdmin(c); err != nil {
		return nil, err
	}
	if err := validStatusList(items); err != nil {
		return nil, err
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		current, err := listStatuses(ctx, t, c.OrgID)
		if err != nil {
			return nil, err
		}
		used, err := tasksByStatus(t)
		if err != nil {
			return nil, err
		}
		kept := map[string]StatusInput{}
		for _, in := range items {
			if in.ID == "" {
				continue
			}
			old, ok := current.byID(in.ID)
			if !ok {
				return nil, refuse(CodeInvalid, "no Status %s in this Organisation's list; a new Status has no id", in.ID)
			}
			if ending(old.Kind) != ending(in.Kind) && used[old.ID] > 0 {
				return nil, refuse(CodeStatusInUse, "%d Tasks are in %s, so its kind can change only among backlog, todo and in_progress",
					used[old.ID], old.Name)
			}
			kept[in.ID] = in
		}
		var deleted []Status
		for _, old := range current {
			if _, ok := kept[old.ID]; !ok {
				deleted = append(deleted, old)
			}
		}
		for from, to := range moves {
			old, ok := current.byID(from)
			if !ok || kept[from].ID != "" {
				return nil, refuse(CodeInvalid, "moves names %s, which is not a Status being deleted", from)
			}
			target, ok := kept[to]
			if !ok {
				return nil, refuse(CodeInvalid, "moves sends the Tasks in %s to %s, which is not a Status kept in the list", old.Name, to)
			}
			if ending(old.Kind) != ending(target.Kind) {
				return nil, refuse(CodeInvalid, "the Tasks in %s cannot move to %s: a Task does not change how it ended through its Status",
					old.Name, target.Name)
			}
		}
		for _, old := range deleted {
			if _, ok := moves[old.ID]; !ok && used[old.ID] > 0 {
				return nil, refuse(CodeStatusInUse, "%d Tasks are in %s; say in moves which Status they go to", used[old.ID], old.Name)
			}
		}
		if unchangedList(current, items) {
			return current, nil
		}

		moved := 0
		for _, old := range deleted {
			if to, ok := moves[old.ID]; ok {
				res, err := t.Exec(ctx, `UPDATE tasks SET status_id = $1 WHERE org_id = $2 AND status_id = $3`, to, c.OrgID, old.ID)
				if err != nil {
					return nil, err
				}
				n, _ := res.RowsAffected()
				moved += int(n)
			}
			if _, err := t.Exec(ctx, `DELETE FROM statuses WHERE org_id = $1 AND id = $2`, c.OrgID, old.ID); err != nil {
				return nil, err
			}
		}
		// Names are unique, so a rename can only land once every kept Status has let go of its old
		// name: each first takes its id, which no name can be.
		for id := range kept {
			if _, err := t.Exec(ctx, `UPDATE statuses SET name = id WHERE org_id = $1 AND id = $2`, c.OrgID, id); err != nil {
				return nil, err
			}
		}
		for i, in := range items {
			name := strings.TrimSpace(in.Name)
			if in.ID != "" {
				if _, err := t.Exec(ctx, `UPDATE statuses SET name = $1, kind = $2, position = $3 WHERE org_id = $4 AND id = $5`,
					name, in.Kind, i+1, c.OrgID, in.ID); err != nil {
					return nil, err
				}
				continue
			}
			if _, err := t.Exec(ctx, `INSERT INTO statuses (id, org_id, name, kind, position, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
				newID(), c.OrgID, name, in.Kind, i+1, ms(t.now)); err != nil {
				return nil, err
			}
		}
		after, err := listStatuses(ctx, t, c.OrgID)
		if err != nil {
			return nil, err
		}
		list := make([]map[string]any, 0, len(after))
		for _, st := range after {
			list = append(list, map[string]any{"id": st.ID, "name": st.Name, "kind": st.Kind, "position": st.Position})
		}
		payload := map[string]any{"statuses": list}
		if len(moves) > 0 {
			payload["moves"], payload["tasks_moved"] = moves, moved
		}
		if err := t.recordByCaller("statuses.changed", c.OrgID, payload); err != nil {
			return nil, err
		}
		return after, nil
	})
	if err != nil {
		return nil, err
	}
	return res.(statuses), nil
}

// validStatusList checks what a list of Statuses says on its own, before reading the record.
func validStatusList(items []StatusInput) error {
	names := map[string]bool{}
	ids := map[string]bool{}
	kinds := map[string]bool{}
	for _, in := range items {
		name := strings.TrimSpace(in.Name)
		if name == "" || utf8.RuneCountInString(name) > 50 {
			return refuse(CodeInvalid, "a Status name is 1 to 50 characters")
		}
		if looksLikeID(name) {
			return refuse(CodeInvalid, "a Status name cannot be spelled as an id")
		}
		if names[strings.ToLower(name)] {
			return refuse(CodeInvalid, "two Statuses are named %q; names are unique, ignoring case", name)
		}
		names[strings.ToLower(name)] = true
		if !slices.Contains(statusKinds, in.Kind) {
			return refuse(CodeInvalid, "a Status's kind is backlog, todo, in_progress, done or dropped, not %q", in.Kind)
		}
		kinds[in.Kind] = true
		if in.ID != "" {
			if ids[in.ID] {
				return refuse(CodeInvalid, "Status %s is in the list twice", in.ID)
			}
			ids[in.ID] = true
		}
	}
	for _, k := range []string{KindTodo, KindInProgress, KindDone, KindDropped} {
		if !kinds[k] {
			return refuse(CodeInvalid, "the list needs a Status of kind %s: Darkory moves Tasks to the first of each", k)
		}
	}
	return nil
}

// unchangedList reports whether items are the current list as it is.
func unchangedList(current statuses, items []StatusInput) bool {
	if len(current) != len(items) {
		return false
	}
	for i, in := range items {
		cur := current[i]
		if in.ID != cur.ID || strings.TrimSpace(in.Name) != cur.Name || in.Kind != cur.Kind || cur.Position != int64(i+1) {
			return false
		}
	}
	return true
}

// tasksByStatus counts the Organisation's Tasks in each Status.
func tasksByStatus(t *tx) (map[string]int, error) {
	rows, err := t.Query(t.ctx, `SELECT status_id, COUNT(*) FROM tasks WHERE org_id = $1 AND status_id IS NOT NULL GROUP BY status_id`, t.caller.OrgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var id string
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, err
		}
		out[id] = n
	}
	return out, rows.Err()
}

// SetTaskStatus moves a Task to another Status of an open kind (ADR 0012, D3): by any Member of
// its Feature's Team, whether or not someone holds it, since the Status says where the Task is in
// its workflow and the Claim stays as it is. Naming the Status it is in writes nothing.
func (s *Service) SetTaskStatus(ctx context.Context, c *auth.Caller, ref, statusRef string, idem Idem) (Task, error) {
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		taskID, err := resolveTask(ctx, t, c.OrgID, ref)
		if err != nil {
			return nil, err
		}
		task, err := getTask(ctx, t, c.OrgID, taskID, t.now)
		if err != nil {
			return nil, err
		}
		if task.State != "open" {
			return nil, refuse(CodeConflict, "Task %s is %s, and stays in its Status", task.Key, task.State)
		}
		f, err := getFeature(ctx, t, c.OrgID, task.FeatureID, t.now)
		if err != nil {
			return nil, err
		}
		if in, err := inTeam(ctx, t, c.OrgID, f.TeamID, c.MemberID); err != nil {
			return nil, err
		} else if !in {
			team, err := getTeam(ctx, t, c.OrgID, f.TeamID)
			if err != nil {
				return nil, err
			}
			return nil, refuse(CodeForbidden, "only a Member of Team %s may move Task %s", team.Key, task.Key)
		}
		list, err := listStatuses(ctx, t, c.OrgID)
		if err != nil {
			return nil, err
		}
		to, err := list.openStatus(statusRef)
		if err != nil {
			return nil, err
		}
		if to.ID == task.StatusID {
			return task, nil
		}
		if _, err := t.Exec(ctx, `UPDATE tasks SET status_id = $1 WHERE org_id = $2 AND id = $3`, to.ID, c.OrgID, taskID); err != nil {
			return nil, err
		}
		if err := t.recordByCaller("task.status_set", taskID, map[string]any{"from": task.StatusID, "to": to.ID}); err != nil {
			return nil, err
		}
		return getTask(ctx, t, c.OrgID, taskID, t.now)
	})
	if err != nil {
		return Task{}, err
	}
	return res.(Task), nil
}

// fileStatus is the Status a Task is filed in: the one named, of an open kind, or else the first
// todo one, so that a Task filed without one is takeable as before.
func fileStatus(t *tx, ref *string) (Status, error) {
	list, err := listStatuses(t.ctx, t, t.caller.OrgID)
	if err != nil {
		return Status{}, err
	}
	if ref != nil {
		return list.openStatus(*ref)
	}
	st := list.first(KindTodo)
	if st.ID == "" {
		return st, fmt.Errorf("core: Organisation %s has no todo Status", t.caller.OrgID)
	}
	return st, nil
}
