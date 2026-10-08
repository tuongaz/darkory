package core

import (
	"cmp"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/shortid"
	"github.com/tuongaz/darkory/internal/store"
)

// A Project's Workflow (ADR 0016): its Steps, each named by the Project and carrying at most one
// Skill, and the Connectors between them, each a named outcome out of one Step into another or
// into Done. A Task's Step is its state; whether it is waiting or being worked follows from its
// Claim. The Steps carrying the builtin breakdown, acceptance and retro Skills are where Darkory
// files the Subtasks it owns about a Parent; a Workflow may have none of them.

const stepCols = `st.id, st.name, st.skill_id, st.position, st.x, st.y`

func scanStep(row interface{ Scan(...any) error }) (Step, error) {
	var s Step
	var skill sql.NullString
	err := row.Scan(&s.ID, &s.Name, &skill, &s.Position, &s.X, &s.Y)
	s.SkillID = nullString(skill)
	return s, err
}

func getStep(ctx context.Context, r store.Reader, orgID, id string) (Step, error) {
	id = shortid.Canonical(id) // either form (ADR 0017)
	s, err := scanStep(r.QueryRow(ctx, `SELECT `+stepCols+` FROM steps st WHERE st.org_id = $1 AND st.id = $2`, orgID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return s, refuse(CodeNotFound, "no Step %s", id)
	}
	return s, err
}

const connectorCols = `k.id, k.from_step_id, k.to_step_id, k.name, k.position`

func scanConnector(row interface{ Scan(...any) error }) (Connector, error) {
	var k Connector
	var to sql.NullString
	err := row.Scan(&k.ID, &k.FromStepID, &to, &k.Name, &k.Position)
	k.ToStepID = nullString(to)
	return k, err
}

// connectorsFrom lists the Connectors out of a Step, in order.
func connectorsFrom(ctx context.Context, r store.Reader, orgID, stepID string) ([]Connector, error) {
	return collect(ctx, r, scanConnector, `SELECT `+connectorCols+` FROM connectors k
WHERE k.org_id = $1 AND k.from_step_id = $2 ORDER BY k.position, k.id`, orgID, stepID)
}

func getWorkflow(ctx context.Context, r store.Reader, orgID, projectID string) (Workflow, error) {
	w := Workflow{ProjectID: projectID}
	var err error
	if w.Steps, err = collect(ctx, r, scanStep, `SELECT `+stepCols+` FROM steps st
WHERE st.org_id = $1 AND st.project_id = $2 ORDER BY st.position, st.id`, orgID, projectID); err != nil {
		return w, err
	}
	w.Connectors, err = collect(ctx, r, scanConnector, `SELECT `+connectorCols+` FROM connectors k JOIN steps st ON st.id = k.from_step_id
WHERE k.org_id = $1 AND k.project_id = $2 ORDER BY st.position, k.position, k.id`, orgID, projectID)
	return w, err
}

// find resolves a reference to one of the Workflow's Steps: its id, or its name in any case,
// since names are unique ignoring case. It matches in Go rather than SQL, whose lower() differs
// between the engines.
func (w Workflow) find(ref string) (Step, bool) {
	ref = strings.TrimSpace(ref)
	for _, s := range w.Steps {
		if s.ID == shortid.Canonical(ref) {
			return s, true
		}
	}
	for _, s := range w.Steps {
		if strings.EqualFold(s.Name, ref) {
			return s, true
		}
	}
	return Step{}, false
}

// stepOf resolves ref to a Step of the Project's Workflow, refusing a name it does not have.
func stepOf(ctx context.Context, r store.Reader, orgID, projectID, ref string) (Step, error) {
	if strings.TrimSpace(ref) == "" {
		return Step{}, refuse(CodeInvalid, "a Step reference is empty")
	}
	w, err := getWorkflow(ctx, r, orgID, projectID)
	if err != nil {
		return Step{}, err
	}
	st, ok := w.find(ref)
	if !ok {
		return Step{}, refuse(CodeNotFound, "the Workflow has no Step %q", ref)
	}
	return st, nil
}

// builtinStep is the first Step of the Project's Workflow carrying the builtin Skill name — the
// breakdown, acceptance or retro Step — or nil when it has none.
func builtinStep(ctx context.Context, r store.Reader, orgID, projectID, name string) (*Step, error) {
	st, err := scanStep(r.QueryRow(ctx, `SELECT `+stepCols+` FROM steps st JOIN skills sk ON sk.id = st.skill_id
WHERE st.org_id = $1 AND st.project_id = $2 AND sk.builtin = TRUE AND sk.name = $3 ORDER BY st.position, st.id LIMIT 1`,
		orgID, projectID, name))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &st, nil
}

// builtinStepSQL is the id of the first Step of the Project @project carrying the Skill @skill
// (an SQL expression), for a batch to file a Subtask at as it stands when the batch runs.
func builtinStepSQL(skill string) string {
	return `(SELECT bs.id FROM steps bs WHERE bs.org_id = @org AND bs.project_id = @project AND bs.skill_id = ` + skill +
		` ORDER BY bs.position, bs.id LIMIT 1)`
}

// defaultStep is the Step a Task is filed at when its filer names none (CONTEXT.md, Workflow):
// the first Step whose Skill is the Project's own work rather than a builtin one Darkory files its
// own Subtasks at (Build in the default Workflow), else the first Step that carries a Skill, else
// the first Step. Break down is a switch on filing, never where a Task lands. Nil when the
// Workflow has no Steps.
func defaultStep(w Workflow, builtin map[string]bool) *Step {
	for _, s := range w.Steps {
		if s.SkillID != nil && !builtin[*s.SkillID] {
			return &s
		}
	}
	for _, s := range w.Steps {
		if s.SkillID != nil {
			return &s
		}
	}
	if len(w.Steps) > 0 {
		return &w.Steps[0]
	}
	return nil
}

// builtinSkills is the set of the Organisation's builtin Skills' ids: breakdown, acceptance,
// retro and skill-review.
func builtinSkills(ctx context.Context, r store.Reader, orgID string) (map[string]bool, error) {
	ids, err := collect(ctx, r, func(row interface{ Scan(...any) error }) (string, error) {
		var id string
		return id, row.Scan(&id)
	}, `SELECT id FROM skills WHERE org_id = $1 AND builtin = TRUE`, orgID)
	out := map[string]bool{}
	for _, id := range ids {
		out[id] = true
	}
	return out, err
}

// outcomes names the Connectors out of a Step, for a refusal: "pass" or "needs changes".
func outcomes(ks []Connector) string {
	if len(ks) == 0 {
		return "it has none"
	}
	names := make([]string, len(ks))
	for i, k := range ks {
		names[i] = "\"" + k.Name + "\""
	}
	return "its outcomes are " + strings.Join(names, ", ")
}

// outcomeNames are the names of the Connectors out of a Step, in order, for a refusal's Details.
func outcomeNames(ks []Connector) []string {
	names := make([]string, len(ks))
	for i, k := range ks {
		names[i] = k.Name
	}
	return names
}

// The Workflows a new Project starts with.
const (
	WorkflowDefault = "default"
	WorkflowEmpty   = "empty"
	WorkflowCopy    = "copy"
)

// plannedStep and plannedConnector describe a Workflow to make, by Step name and Skill name, and
// where the canvas draws each Step.
type plannedStep struct {
	name, skill string
	x, y        int64
}
type plannedConnector struct{ from, to, name string }

// defaultWorkflow is the Workflow a new Project starts with unless its creator picks another
// (model-v2-plan.md, "The default Workflow"): a Backlog hold, Plan, Build, Review, and the
// Retrospective's Steps. No Acceptance: a Project that wants one adds the Step and turns it on.
// It is drawn compact, in the board's order: a column of Backlog, Plan, Build and Retro, with
// Review beside Build and Skill review beside Retro, so a new Project opens with Done in view
// (decisions.md, W0).
var defaultWorkflow = struct {
	steps      []plannedStep
	connectors []plannedConnector
}{
	steps: []plannedStep{
		{"Backlog", "", 0, 0}, {"Plan", SkillBreakdown, 0, 128}, {"Build", SkillEngineer, 0, 256}, {"Review", SkillReview, 448, 256},
		{"Retro", SkillRetro, 0, 384}, {"Skill review", SkillSkillReview, 448, 384},
	},
	connectors: []plannedConnector{
		{"Plan", "", "done"},
		{"Build", "Review", "pass"},
		{"Review", "", "pass"}, {"Review", "Build", "needs changes"},
		{"Retro", "", "done"}, {"Retro", "Skill review", "propose"},
		{"Skill review", "", "publish"}, {"Skill review", "Retro", "needs changes"},
	},
}

// emptyWorkflow is a Backlog hold leading to Done, for a Project that draws its own.
var emptyWorkflow = struct {
	steps      []plannedStep
	connectors []plannedConnector
}{
	steps:      []plannedStep{{"Backlog", "", 0, 0}},
	connectors: []plannedConnector{{"Backlog", "", "done"}},
}

// stepSpacing is how far apart, in pixels, the canvas draws one Step from the next in a row: a
// node 208 wide and the plan's 240 between them. A new Step given no place is drawn in the first
// row, at its position's place.
const stepSpacing = 448

// seedWorkflow gives a new Project its first Workflow inside a write: the default one, the empty
// one, or a copy of another Project's.
func seedWorkflow(t *tx, projectID, kind, from string) error {
	var steps []StepInput
	var connectors []ConnectorInput
	switch kind {
	case WorkflowCopy:
		w, err := getWorkflow(t.ctx, t, t.caller.OrgID, from)
		if err != nil {
			return err
		}
		names := map[string]string{}
		for _, s := range w.Steps {
			names[s.ID] = s.Name
			steps = append(steps, StepInput{Name: s.Name, Skill: s.SkillID, Position: s.Position, X: ptr(s.X), Y: ptr(s.Y)})
		}
		for _, k := range w.Connectors {
			ci := ConnectorInput{From: names[k.FromStepID], Name: k.Name, Position: k.Position}
			if k.ToStepID != nil {
				ci.To = ptr(names[*k.ToStepID])
			}
			connectors = append(connectors, ci)
		}
	default:
		plan := defaultWorkflow
		if kind == WorkflowEmpty {
			plan = emptyWorkflow
		}
		for i, ps := range plan.steps {
			in := StepInput{Name: ps.name, Position: int64(i + 1), X: ptr(ps.x), Y: ptr(ps.y)}
			if ps.skill != "" {
				id, err := ensureSkill(t, ps.skill)
				if err != nil {
					return err
				}
				in.Skill = &id
			}
			steps = append(steps, in)
		}
		for _, pc := range plan.connectors {
			ci := ConnectorInput{From: pc.from, Name: pc.name}
			if pc.to != "" {
				ci.To = ptr(pc.to)
			}
			connectors = append(connectors, ci)
		}
	}
	_, err := replaceWorkflow(t, projectID, WorkflowInput{Steps: steps, Connectors: connectors})
	return err
}

// ensureSkill is the id of the Skill name, creating it as a generic Skill when the Organisation
// has none so named: the default Workflow's Build and Review Steps carry engineer and review,
// which `darkory init` seeds but an Install from before model v2 may lack.
func ensureSkill(t *tx, name string) (string, error) {
	id, err := skillByName(t.ctx, t, t.caller.OrgID, name)
	if codeOf(err) != CodeNotFound {
		return id, err
	}
	for _, b := range seededSkills {
		if b.name == name {
			return createSkill(t, b.name, "generic", nil, b.body, b.builtin)
		}
	}
	return createSkill(t, name, "generic", nil, name, false)
}

func codeOf(err error) Code {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

// WorkflowInput is the whole Workflow SetWorkflow puts in place of a Project's. The order of its
// lists is not read: each Step's and Connector's Position says where it goes.
type WorkflowInput struct {
	Steps      []StepInput
	Connectors []ConnectorInput
	// Moves says where the open Tasks at each Step left out go: the deleted Step's id → a Step of
	// the new Workflow, by id or name.
	Moves map[string]string
}

// StepInput is one Step of a Workflow being set: ID names one the Workflow has now, and is empty
// for a new one. Skill names a Skill by id or name; nil for a hold. Position is its place, 1
// first, distinct among the Steps, and the Workflow numbers them 1, 2, 3… in that order; 0 reads
// as its place in the list, for a caller that sends them in order. X and Y, when nil, keep a
// Step's place on the canvas, and put a new one at ((Position − 1) × 448, 0).
type StepInput struct {
	ID       string
	Name     string
	Skill    *string
	Position int64
	X, Y     *int64
}

// ConnectorInput is one Connector of a Workflow being set. From and To name Steps of the new
// Workflow by id or name; To nil is Done. ID names one the Workflow has now, and may be left out:
// a Connector out of the same Step with the same name keeps its id. Position is its place among
// the Connectors out of its Step, as a Step's is among the Steps.
type ConnectorInput struct {
	ID       string
	From     string
	To       *string
	Name     string
	Position int64
}

// SetWorkflow replaces a Project's Workflow with w (admin) and returns it as GetWorkflow does,
// with its live facts. A Step left out is deleted; the open Tasks at it go where w.Moves says,
// and are refused step_in_use when it does not say. A Step's Skill may change: the Tasks at it
// keep their place, and the next `next` reads the new Skill. A connector naming a Step the new
// Workflow does not have, two Connectors out of one Step with one name, and two Steps, or two
// Connectors out of one Step, at one position are refused invalid. The Tasks moved keep their
// Claims. A Workflow may have no Steps: filing in the Project is then refused no_step.
func (s *Service) SetWorkflow(ctx context.Context, c *auth.Caller, projectRef string, w WorkflowInput, idem Idem) (WorkflowDetail, error) {
	if err := mustAdmin(c); err != nil {
		return WorkflowDetail{}, err
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		projectID, err := resolveProject(ctx, t, c.OrgID, projectRef)
		if err != nil {
			return nil, err
		}
		if _, err := replaceWorkflow(t, projectID, w); err != nil {
			return nil, err
		}
		return workflowDetail(ctx, t, c.OrgID, projectID, t.now)
	})
	if err != nil {
		return WorkflowDetail{}, err
	}
	return res.(WorkflowDetail), nil
}

// resolvedWorkflow is a WorkflowInput checked against the record: every Step and Connector with
// its id, Skill and place.
type resolvedWorkflow struct {
	steps      []Step
	connectors []Connector
	// moves maps a deleted Step's id to the id of the Step its Tasks go to.
	moves map[string]string
}

// replaceWorkflow puts w in place of the Project's Workflow inside a write, recording
// workflow.changed, and returns it; an unchanged Workflow writes nothing.
func replaceWorkflow(t *tx, projectID string, w WorkflowInput) (Workflow, error) {
	ctx, org := t.ctx, t.caller.OrgID
	current, err := getWorkflow(ctx, t, org, projectID)
	if err != nil {
		return Workflow{}, err
	}
	next, err := resolveWorkflow(t, current, w)
	if err != nil {
		return Workflow{}, err
	}
	kept := map[string]bool{}
	for _, st := range next.steps {
		kept[st.ID] = true
	}
	var deleted []Step
	for _, st := range current.Steps {
		if !kept[st.ID] {
			deleted = append(deleted, st)
		}
	}
	at := map[string][]string{}
	for _, st := range deleted {
		ids, err := collect(ctx, t, func(row interface{ Scan(...any) error }) (string, error) {
			var id string
			return id, row.Scan(&id)
		}, `SELECT id FROM tasks WHERE org_id = $1 AND step_id = $2 ORDER BY id`, org, st.ID)
		if err != nil {
			return Workflow{}, err
		}
		if _, ok := next.moves[st.ID]; !ok && len(ids) > 0 {
			return Workflow{}, refuse(CodeStepInUse, "%d open Tasks are at %s; say in moves which Step they go to", len(ids), st.Name)
		}
		at[st.ID] = ids
	}
	if sameWorkflow(current, next) {
		return current, nil
	}

	// Names are unique in a Project, so a rename lands only once every Step there now has let go
	// of its name: each first takes its id, which no name can be. Connectors are put back whole.
	if _, err := t.Exec(ctx, `DELETE FROM connectors WHERE org_id = $1 AND project_id = $2`, org, projectID); err != nil {
		return Workflow{}, err
	}
	if _, err := t.Exec(ctx, `UPDATE steps SET name = id WHERE org_id = $1 AND project_id = $2`, org, projectID); err != nil {
		return Workflow{}, err
	}
	was := map[string]bool{}
	for _, st := range current.Steps {
		was[st.ID] = true
	}
	for _, st := range next.steps {
		if was[st.ID] {
			continue
		}
		if _, err := t.Exec(ctx, `INSERT INTO steps (id, org_id, project_id, name, skill_id, position, x, y, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, st.ID, org, projectID, st.ID, st.SkillID, st.Position, st.X, st.Y, ms(t.now)); err != nil {
			return Workflow{}, err
		}
	}
	moved := 0
	for _, st := range deleted {
		to, ok := next.moves[st.ID]
		if !ok {
			continue
		}
		for _, id := range at[st.ID] {
			if err := moveToStep(t, id, &st.ID, to, map[string]any{"workflow_changed": true}); err != nil {
				return Workflow{}, err
			}
			moved++
		}
	}
	for _, st := range deleted {
		if _, err := t.Exec(ctx, `DELETE FROM steps WHERE org_id = $1 AND id = $2`, org, st.ID); err != nil {
			return Workflow{}, err
		}
	}
	for _, st := range next.steps {
		if _, err := t.Exec(ctx, `UPDATE steps SET name = $1, skill_id = $2, position = $3, x = $4, y = $5 WHERE org_id = $6 AND id = $7`,
			st.Name, st.SkillID, st.Position, st.X, st.Y, org, st.ID); err != nil {
			return Workflow{}, err
		}
	}
	for _, k := range next.connectors {
		if _, err := t.Exec(ctx, `INSERT INTO connectors (id, org_id, project_id, from_step_id, to_step_id, name, position, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, k.ID, org, projectID, k.FromStepID, k.ToStepID, k.Name, k.Position, ms(t.now)); err != nil {
			return Workflow{}, err
		}
	}

	after, err := getWorkflow(ctx, t, org, projectID)
	if err != nil {
		return Workflow{}, err
	}
	steps := make([]map[string]any, len(after.Steps))
	for i, st := range after.Steps {
		steps[i] = map[string]any{"id": st.ID, "name": st.Name, "skill_id": st.SkillID, "position": st.Position}
	}
	connectors := make([]map[string]any, len(after.Connectors))
	for i, k := range after.Connectors {
		connectors[i] = map[string]any{"id": k.ID, "from": k.FromStepID, "to": k.ToStepID, "name": k.Name}
	}
	payload := map[string]any{"steps": steps, "connectors": connectors}
	if len(next.moves) > 0 {
		payload["moves"], payload["tasks_moved"] = next.moves, moved
	}
	if err := t.recordByCaller("workflow.changed", projectID, payload); err != nil {
		return Workflow{}, err
	}
	return after, nil
}

// resolveWorkflow checks w on its own and against the Workflow it replaces and the Skills.
func resolveWorkflow(t *tx, current Workflow, w WorkflowInput) (resolvedWorkflow, error) {
	var out resolvedWorkflow
	names := map[string]bool{}
	ids := map[string]bool{}
	stepAt, err := places("two Steps", len(w.Steps), func(i int) int64 { return w.Steps[i].Position })
	if err != nil {
		return out, err
	}
	for i, in := range w.Steps {
		name := strings.TrimSpace(in.Name)
		if err := validWorkflowName("a Step's name", name); err != nil {
			return out, err
		}
		if names[strings.ToLower(name)] {
			return out, refuse(CodeInvalid, "two Steps are named %q; names are unique, ignoring case", name)
		}
		names[strings.ToLower(name)] = true
		st := Step{ID: in.ID, Name: name, Position: stepAt[i], X: (stepAt[i] - 1) * stepSpacing}
		if in.ID != "" {
			j := slices.IndexFunc(current.Steps, func(s Step) bool { return s.ID == in.ID })
			if j < 0 {
				return out, refuse(CodeInvalid, "the Workflow has no Step %s; a new Step has no id", in.ID)
			}
			if ids[in.ID] {
				return out, refuse(CodeInvalid, "Step %s is in the Workflow twice", in.ID)
			}
			ids[in.ID] = true
			st.X, st.Y = current.Steps[j].X, current.Steps[j].Y
		} else {
			st.ID = newID()
		}
		if in.X != nil {
			st.X = *in.X
		}
		if in.Y != nil {
			st.Y = *in.Y
		}
		if in.Skill != nil {
			id, err := resolveSkill(t.ctx, t, t.caller.OrgID, *in.Skill)
			if err != nil {
				return out, err
			}
			st.SkillID = &id
		}
		out.steps = append(out.steps, st)
	}
	slices.SortFunc(out.steps, func(a, b Step) int { return cmp.Compare(a.Position, b.Position) })
	next := Workflow{Steps: out.steps}
	find := func(what, ref string) (string, error) {
		st, ok := next.find(ref)
		if !ok {
			return "", refuse(CodeInvalid, "%s names %q, which is not a Step of the Workflow", what, ref)
		}
		return st.ID, nil
	}

	claimed := map[string]bool{}
	for _, in := range w.Connectors {
		if in.ID != "" {
			if !slices.ContainsFunc(current.Connectors, func(k Connector) bool { return k.ID == in.ID }) {
				return out, refuse(CodeInvalid, "the Workflow has no Connector %s; a new Connector has no id", in.ID)
			}
			if claimed[in.ID] {
				return out, refuse(CodeInvalid, "Connector %s is in the Workflow twice", in.ID)
			}
			claimed[in.ID] = true
		}
	}
	out.connectors = []Connector{}
	outs := map[string]map[string]bool{}
	given := map[string][]int64{}
	for _, in := range w.Connectors {
		name := strings.TrimSpace(in.Name)
		if err := validWorkflowName("a Connector's name", name); err != nil {
			return out, err
		}
		from, err := find("a Connector", in.From)
		if err != nil {
			return out, err
		}
		k := Connector{ID: in.ID, FromStepID: from, Name: name}
		if in.To != nil {
			to, err := find("a Connector", *in.To)
			if err != nil {
				return out, err
			}
			k.ToStepID = &to
		}
		if outs[from] == nil {
			outs[from] = map[string]bool{}
		}
		if outs[from][strings.ToLower(name)] {
			st, _ := next.find(from)
			return out, refuse(CodeInvalid, "two Connectors out of %s are named %q; a Step's outcomes are unique, ignoring case", st.Name, name)
		}
		outs[from][strings.ToLower(name)] = true
		given[from] = append(given[from], in.Position)
		if k.ID == "" {
			// A Connector sent back without its id keeps it, so a Workflow put back as read is
			// unchanged.
			for _, old := range current.Connectors {
				if !claimed[old.ID] && old.FromStepID == from && strings.EqualFold(old.Name, name) {
					k.ID, claimed[old.ID] = old.ID, true
					break
				}
			}
			if k.ID == "" {
				k.ID = newID()
			}
		}
		out.connectors = append(out.connectors, k)
	}
	// Each Step's Connectors take their places among themselves, in the order of the Steps.
	at := map[string][]int64{}
	for from, ps := range given {
		st, _ := next.find(from)
		if at[from], err = places("two Connectors out of "+st.Name, len(ps), func(i int) int64 { return ps[i] }); err != nil {
			return out, err
		}
	}
	seen := map[string]int{}
	for i := range out.connectors {
		from := out.connectors[i].FromStepID
		out.connectors[i].Position = at[from][seen[from]]
		seen[from]++
	}
	stepPos := map[string]int64{}
	for _, st := range out.steps {
		stepPos[st.ID] = st.Position
	}
	slices.SortFunc(out.connectors, func(a, b Connector) int {
		return cmp.Or(cmp.Compare(stepPos[a.FromStepID], stepPos[b.FromStepID]), cmp.Compare(a.Position, b.Position))
	})

	out.moves = map[string]string{}
	for given, to := range w.Moves {
		from := shortid.Canonical(given) // either form (ADR 0017)
		if ids[from] || !slices.ContainsFunc(current.Steps, func(s Step) bool { return s.ID == from }) {
			return out, refuse(CodeInvalid, "moves names %s, which is not a Step being deleted", from)
		}
		id, err := find("moves", to)
		if err != nil {
			return out, err
		}
		out.moves[from] = id
	}
	return out, nil
}

// places numbers n Steps, or n Connectors out of one Step, 1 to n in the order of their
// positions, pos(i) for the i-th in the list; a position of 0 reads as its place in the list.
// Two at one position, or one below 0, are refused invalid.
func places(what string, n int, pos func(i int) int64) ([]int64, error) {
	given := make([]int64, n)
	order := make([]int, n)
	taken := map[int64]bool{}
	for i := range n {
		given[i], order[i] = pos(i), i
		if given[i] < 0 {
			return nil, refuse(CodeInvalid, "a position is 1 or more, not %d", given[i])
		}
		if given[i] == 0 {
			given[i] = int64(i + 1)
		}
		if taken[given[i]] {
			return nil, refuse(CodeInvalid, "%s are at position %d; each has a place of its own", what, given[i])
		}
		taken[given[i]] = true
	}
	slices.SortFunc(order, func(a, b int) int { return cmp.Compare(given[a], given[b]) })
	out := make([]int64, n)
	for place, i := range order {
		out[i] = int64(place + 1)
	}
	return out, nil
}

func validWorkflowName(what, name string) error {
	if name == "" || utf8.RuneCountInString(name) > 50 || strings.ContainsFunc(name, unicode.IsControl) {
		return refuse(CodeInvalid, "%s is 1 to 50 characters, on one line", what)
	}
	if looksLikeID(name) {
		return refuse(CodeInvalid, "%s cannot be spelled as an id", what)
	}
	return nil
}

// sameWorkflow reports whether next is the current Workflow as it is.
func sameWorkflow(current Workflow, next resolvedWorkflow) bool {
	if len(next.moves) > 0 || len(current.Steps) != len(next.steps) || len(current.Connectors) != len(next.connectors) {
		return false
	}
	for i, st := range next.steps {
		cur := current.Steps[i]
		if st.ID != cur.ID || st.Name != cur.Name || !sameRef(st.SkillID, cur.SkillID) || st.Position != cur.Position ||
			st.X != cur.X || st.Y != cur.Y {
			return false
		}
	}
	byID := map[string]Connector{}
	for _, k := range current.Connectors {
		byID[k.ID] = k
	}
	for _, k := range next.connectors {
		cur, ok := byID[k.ID]
		if !ok || cur.FromStepID != k.FromStepID || !sameRef(cur.ToStepID, k.ToStepID) || cur.Name != k.Name || cur.Position != k.Position {
			return false
		}
	}
	return true
}

// GetWorkflow returns a Project's Workflow with the live facts of each Step.
func (s *Service) GetWorkflow(ctx context.Context, c *auth.Caller, projectRef string) (WorkflowDetail, error) {
	projectID, err := resolveProject(ctx, s.store, c.OrgID, projectRef)
	if err != nil {
		return WorkflowDetail{}, err
	}
	return workflowDetail(ctx, s.store, c.OrgID, projectID, s.clock.Now())
}

// workflowDetail reads a Project's Workflow with the live facts of each Step as of now.
func workflowDetail(ctx context.Context, r store.Reader, orgID, projectID string, now time.Time) (WorkflowDetail, error) {
	w, err := getWorkflow(ctx, r, orgID, projectID)
	if err != nil {
		return WorkflowDetail{}, err
	}
	d := WorkflowDetail{Workflow: w, Facts: make([]StepFacts, len(w.Steps))}
	at := map[string]int{}
	for i, st := range w.Steps {
		d.Facts[i] = StepFacts{StepID: st.ID, Takers: []Taker{}}
		at[st.ID] = i
	}

	rows, err := r.Query(ctx, `SELECT step_id, COUNT(*),
SUM(CASE WHEN claim_holder_id IS NOT NULL AND (claim_expires_at IS NULL OR claim_expires_at > $3) THEN 1 ELSE 0 END)
FROM tasks WHERE org_id = $1 AND project_id = $2 AND state = 'open' AND step_id IS NOT NULL GROUP BY step_id`, orgID, projectID, ms(now))
	if err != nil {
		return d, err
	}
	for rows.Next() {
		var step string
		var n, working int
		if err := rows.Scan(&step, &n, &working); err != nil {
			rows.Close()
			return d, err
		}
		if i, ok := at[step]; ok {
			d.Facts[i].Tasks, d.Facts[i].Working = n, working
		}
	}
	rows.Close()

	// The takers of a Step are those who could take a Task at it by its Skill (takeableSQL).
	rows, err = r.Query(ctx, `SELECT st.id, m.id, m.name, m.kind FROM steps st
JOIN skills sk ON sk.id = st.skill_id JOIN member_skills ms ON ms.skill_id = st.skill_id JOIN members m ON m.id = ms.member_id
WHERE st.org_id = $1 AND st.project_id = $2 AND m.deactivated_at IS NULL
AND (EXISTS (SELECT 1 FROM project_members pm WHERE pm.org_id = $1 AND pm.project_id = $2 AND pm.member_id = m.id)
	OR (sk.builtin = TRUE AND sk.name = 'skill-review'))
ORDER BY st.position, m.name`, orgID, projectID)
	if err != nil {
		return d, err
	}
	for rows.Next() {
		var step string
		var tk Taker
		if err := rows.Scan(&step, &tk.MemberID, &tk.Name, &tk.Kind); err != nil {
			rows.Close()
			return d, err
		}
		if i, ok := at[step]; ok {
			d.Facts[i].Takers = append(d.Facts[i].Takers, tk)
		}
	}
	rows.Close()

	dwells, err := stepDwells(ctx, r, orgID, projectID, now.Add(-30*24*time.Hour))
	if err != nil {
		return d, err
	}
	for step, ds := range dwells {
		if i, ok := at[step]; ok {
			d.Facts[i].MedianMS = ptr(median(ds))
		}
	}
	return d, nil
}

// dwellKinds are the Activity entries that record a Task leaving a Step: each carries the Step
// left as from and when the Task reached it as since.
var dwellKinds = []string{"task.advanced", "task.moved", "task.completed", "task.dropped", "task.became_parent"}

// stepDwells reads, for each Step of the Project, how long the Tasks that left it since cut had
// been at it, in milliseconds.
func stepDwells(ctx context.Context, r store.Reader, orgID, projectID string, cut time.Time) (map[string][]int64, error) {
	args := []any{orgID, projectID, ms(cut)}
	marks := make([]string, len(dwellKinds))
	for i, k := range dwellKinds {
		args = append(args, k)
		marks[i] = "$" + itoa(len(args))
	}
	rows, err := r.Query(ctx, `SELECT a.at, a.payload FROM activity a JOIN tasks t ON t.org_id = a.org_id AND t.id = a.subject_id
WHERE a.org_id = $1 AND t.project_id = $2 AND a.at >= $3 AND a.kind IN (`+strings.Join(marks, ", ")+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]int64{}
	for rows.Next() {
		var at int64
		var payload string
		if err := rows.Scan(&at, &payload); err != nil {
			return nil, err
		}
		var p struct {
			From  *string `json:"from"`
			Since *int64  `json:"since"`
		}
		if json.Unmarshal([]byte(payload), &p) != nil || p.From == nil || p.Since == nil || *p.Since > at {
			continue
		}
		out[*p.From] = append(out[*p.From], at-*p.Since)
	}
	return out, rows.Err()
}

// median is the middle of ds, or the mean of the two middles.
func median(ds []int64) int64 {
	slices.Sort(ds)
	n := len(ds)
	if n%2 == 1 {
		return ds[n/2]
	}
	return (ds[n/2-1] + ds[n/2]) / 2
}
