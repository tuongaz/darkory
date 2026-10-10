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

// A Project's Workflows (ADR 0016, ADR 0019): one or more, each named and positioned; its Steps,
// each in one Workflow, named uniquely across the Project and carrying at most one Skill; and the
// Connectors between them, each a named outcome out of one Step into another Step, of its
// Workflow or of another of the Project's, or into Done. A Task's Step is its state, and its
// Workflow is that of its Step; whether it is waiting or being worked follows from its Claim. The
// Project's Steps are ordered by their Workflow's position, then their own: "the first Step" and
// the first Step carrying each of the builtin breakdown, acceptance and retro Skills, where
// Darkory files the Subtasks it owns about a Parent, read that order. A Project may have none of
// them. The whole graph is written at once, so a crossing Connector and the Step it reaches land
// together.

// stepCols names the columns, never *: steps' column order differs between the engines.
const stepCols = `st.id, st.workflow_id, st.name, st.skill_id, st.position, st.x, st.y`

func scanStep(row interface{ Scan(...any) error }) (Step, error) {
	var s Step
	var skill sql.NullString
	err := row.Scan(&s.ID, &s.WorkflowID, &s.Name, &skill, &s.Position, &s.X, &s.Y)
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

// getWorkflow reads a Project's whole graph in the Project's order: the Workflows by position,
// the Steps by their Workflow's position then their own, the Connectors by their Step's order
// then their own.
func getWorkflow(ctx context.Context, r store.Reader, orgID, projectID string) (Workflows, error) {
	w := Workflows{ProjectID: projectID}
	var err error
	if w.Workflows, err = getWorkflowRows(ctx, r, orgID, projectID); err != nil {
		return w, err
	}
	if w.Steps, err = getSteps(ctx, r, orgID, projectID); err != nil {
		return w, err
	}
	w.Connectors, err = collect(ctx, r, scanConnector, `SELECT `+connectorCols+` FROM connectors k
JOIN steps st ON st.org_id = k.org_id AND st.id = k.from_step_id
JOIN workflows w ON w.org_id = st.org_id AND w.id = st.workflow_id
WHERE k.org_id = $1 AND k.project_id = $2 ORDER BY w.position, st.position, k.position, k.id`, orgID, projectID)
	return w, err
}

// getWorkflowRows reads a Project's Workflows alone, by position.
func getWorkflowRows(ctx context.Context, r store.Reader, orgID, projectID string) ([]Workflow, error) {
	return collect(ctx, r, func(row interface{ Scan(...any) error }) (Workflow, error) {
		var wf Workflow
		return wf, row.Scan(&wf.ID, &wf.Name, &wf.Position)
	}, `SELECT id, name, position FROM workflows WHERE org_id = $1 AND project_id = $2 ORDER BY position, id`, orgID, projectID)
}

// getSteps reads a Project's Steps in the Project's order: by their Workflow's position, then
// their own.
func getSteps(ctx context.Context, r store.Reader, orgID, projectID string) ([]Step, error) {
	return collect(ctx, r, scanStep, `SELECT `+stepCols+` FROM steps st JOIN workflows w ON w.org_id = st.org_id AND w.id = st.workflow_id
WHERE st.org_id = $1 AND st.project_id = $2 ORDER BY w.position, st.position, st.id`, orgID, projectID)
}

// find resolves a reference to one of the Project's Steps, in any of its Workflows: its id, or
// its name in any case, since names are unique ignoring case. It matches in Go rather than SQL,
// whose lower() differs between the engines.
func (w Workflows) find(ref string) (Step, bool) {
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

// findWorkflow resolves a reference to one of the Project's Workflows: its id, either form, or its
// name in any case, since names are unique ignoring case.
func (w Workflows) findWorkflow(ref string) (Workflow, bool) {
	ref = strings.TrimSpace(ref)
	for _, wf := range w.Workflows {
		if wf.ID == shortid.Canonical(ref) {
			return wf, true
		}
	}
	for _, wf := range w.Workflows {
		if strings.EqualFold(wf.Name, ref) {
			return wf, true
		}
	}
	return Workflow{}, false
}

// workflowByID reads a Workflow by its id, either form, in any Project of the organisation.
func workflowByID(ctx context.Context, r store.Reader, orgID, id string) (Workflow, error) {
	id = shortid.Canonical(id) // either form (ADR 0017)
	var wf Workflow
	err := r.QueryRow(ctx, `SELECT id, name, position FROM workflows WHERE org_id = $1 AND id = $2`, orgID, id).
		Scan(&wf.ID, &wf.Name, &wf.Position)
	if errors.Is(err, sql.ErrNoRows) {
		return wf, refuse(CodeNotFound, "no Workflow %s", id)
	}
	return wf, err
}

// workflowOf resolves ref to a Workflow of the Project, by its id or its name, refusing one it
// does not have.
func workflowOf(ctx context.Context, r store.Reader, orgID, projectID, ref string) (Workflow, error) {
	if strings.TrimSpace(ref) == "" {
		return Workflow{}, refuse(CodeInvalid, "a Workflow reference is empty")
	}
	wfs, err := getWorkflowRows(ctx, r, orgID, projectID)
	if err != nil {
		return Workflow{}, err
	}
	wf, ok := Workflows{Workflows: wfs}.findWorkflow(ref)
	if !ok {
		return Workflow{}, refuse(CodeNotFound, "the Project has no Workflow %q", ref)
	}
	return wf, nil
}

// stepOf resolves ref to a Step of the Project, in any of its Workflows, refusing a name it does
// not have.
func stepOf(ctx context.Context, r store.Reader, orgID, projectID, ref string) (Step, error) {
	if strings.TrimSpace(ref) == "" {
		return Step{}, refuse(CodeInvalid, "a Step reference is empty")
	}
	steps, err := getSteps(ctx, r, orgID, projectID)
	if err != nil {
		return Step{}, err
	}
	st, ok := Workflows{Steps: steps}.find(ref)
	if !ok {
		return Step{}, refuse(CodeNotFound, "the Project has no Step %q", ref)
	}
	return st, nil
}

// builtinStep is the first Step of the Project, in its order, carrying the builtin Skill name —
// the breakdown, acceptance or retro Step — or nil when it has none.
func builtinStep(ctx context.Context, r store.Reader, orgID, projectID, name string) (*Step, error) {
	st, err := scanStep(r.QueryRow(ctx, `SELECT `+stepCols+` FROM steps st JOIN skills sk ON sk.id = st.skill_id
JOIN workflows w ON w.id = st.workflow_id
WHERE st.org_id = $1 AND st.project_id = $2 AND sk.builtin = TRUE AND sk.name = $3 ORDER BY w.position, st.position, st.id LIMIT 1`,
		orgID, projectID, name))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &st, nil
}

// builtinStepSQL is the id of the first Step of the Project @project, in its order, carrying the
// Skill @skill (an SQL expression), for a batch to file a Subtask at as it stands when the batch
// runs. It stays one subquery, so the batch's round trips do not change (invariant 4).
func builtinStepSQL(skill string) string {
	return `(SELECT bs.id FROM steps bs JOIN workflows bw ON bw.id = bs.workflow_id WHERE bs.org_id = @org AND bs.project_id = @project AND bs.skill_id = ` + skill +
		` ORDER BY bw.position, bs.position, bs.id LIMIT 1)`
}

// defaultStep is the Step a Task is filed at when its filer names none (CONTEXT.md, Workflow):
// the first Step whose Skill is the Project's own work rather than a builtin one Darkory files its
// own Subtasks at (Build in a default Project's Implementation), else the first Step that carries
// a Skill, else the first Step, each in the Project's order across its Workflows. Break down is a
// switch on filing, never where a Task lands. Nil when the Project has no Steps.
func defaultStep(w Workflows, builtin map[string]bool) *Step {
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

// The two Workflows a default Project starts with (sample-workflows-plan.md).
const (
	WorkflowImplementation = "Implementation"
	WorkflowBugTriage      = "Bug triage"
)

// plannedStep and plannedConnector describe a Workflow to make, by Step name and Skill name, and
// where the canvas draws each Step.
type plannedStep struct {
	name, skill string
	x, y        int64
}
type plannedConnector struct{ from, to, name string }

// plannedWorkflow is a Workflow to make: its name, its Steps in order, and the Connectors out of
// them. A Connector's to may name a Step of another planned Workflow; Step names are unique per
// Project, so a name is enough.
type plannedWorkflow struct {
	name       string
	steps      []plannedStep
	connectors []plannedConnector
}

// defaultWorkflows are the Workflows a new Project starts with unless its creator picks others
// (sample-workflows-plan.md), in order.
//
// Implementation is the default Workflow of model-v2-plan.md ("The default Workflow"): a Backlog
// hold, Plan, Build, Review, and the Retrospective's Steps. No Acceptance: a Project that wants
// one adds the Step and turns it on. It is drawn compact, in the board's order: a column of
// Backlog, Plan, Build and Retro, with Review beside Build and Skill review beside Retro, so a new
// Project opens with Done in view (decisions.md, W0). Being first, it holds Build, where a Task
// filed without a Step starts.
//
// Bug triage takes a reported problem: Triage, then Fix, Code review and Verify in a row. Triage
// leads to Fix (bug), to Done (not a bug), or into Implementation's Build (feature). Its review
// Step is Code review because Implementation has the Review.
var defaultWorkflows = []plannedWorkflow{
	{
		name: WorkflowImplementation,
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
	},
	{
		name: WorkflowBugTriage,
		steps: []plannedStep{
			{"Triage", SkillTriage, 0, 0}, {"Fix", SkillEngineer, 448, 0}, {"Code review", SkillReview, 896, 0}, {"Verify", SkillQA, 1344, 0},
		},
		connectors: []plannedConnector{
			{"Triage", "Fix", "bug"}, {"Triage", "", "not a bug"}, {"Triage", "Build", "feature"},
			{"Fix", "Code review", "ready"},
			{"Code review", "Verify", "pass"}, {"Code review", "Fix", "needs changes"},
			{"Verify", "", "pass"}, {"Verify", "Fix", "fail"},
		},
	},
}

// emptyWorkflow is one Workflow, Work, a Backlog hold leading to Done, for a Project that draws
// its own.
var emptyWorkflow = plannedWorkflow{
	name:       WorkflowFirstName,
	steps:      []plannedStep{{"Backlog", "", 0, 0}},
	connectors: []plannedConnector{{"Backlog", "", "done"}},
}

// stepSpacing is how far apart, in pixels, the canvas draws one Step from the next in a row: a
// node 208 wide and the plan's 240 between them. A new Step given no place is drawn in the first
// row, at its position's place.
const stepSpacing = 448

// seedWorkflow gives a new Project its first Workflows inside a write: the default two,
// Implementation and Bug triage, the empty one, Work, or a copy of another Project's, Workflows
// and all.
func seedWorkflow(t *tx, projectID, kind, from string) error {
	var in WorkflowsInput
	switch kind {
	case WorkflowCopy:
		w, err := getWorkflow(t.ctx, t, t.caller.OrgID, from)
		if err != nil {
			return err
		}
		wfName := map[string]string{}
		for _, wf := range w.Workflows {
			wfName[wf.ID] = wf.Name
			in.Workflows = append(in.Workflows, WorkflowInput{Name: wf.Name, Position: wf.Position})
		}
		names := map[string]string{}
		for _, s := range w.Steps {
			names[s.ID] = s.Name
			skill, err := copiedSkill(t, s.SkillID)
			if err != nil {
				return err
			}
			in.Steps = append(in.Steps, StepInput{Workflow: wfName[s.WorkflowID], Name: s.Name, Skill: skill, Position: s.Position,
				X: ptr(s.X), Y: ptr(s.Y)})
		}
		for _, k := range w.Connectors {
			ci := ConnectorInput{From: names[k.FromStepID], Name: k.Name, Position: k.Position}
			if k.ToStepID != nil {
				ci.To = ptr(names[*k.ToStepID])
			}
			in.Connectors = append(in.Connectors, ci)
		}
	default:
		plan := defaultWorkflows
		if kind == WorkflowEmpty {
			plan = []plannedWorkflow{emptyWorkflow}
		}
		for i, pw := range plan {
			in.Workflows = append(in.Workflows, WorkflowInput{Name: pw.name, Position: int64(i + 1)})
			for j, ps := range pw.steps {
				si := StepInput{Workflow: pw.name, Name: ps.name, Position: int64(j + 1), X: ptr(ps.x), Y: ptr(ps.y)}
				if ps.skill != "" {
					id, err := ensureSkill(t, ps.skill)
					if err != nil {
						return err
					}
					si.Skill = &id
				}
				in.Steps = append(in.Steps, si)
			}
			for _, pc := range pw.connectors {
				ci := ConnectorInput{From: pc.from, Name: pc.name}
				if pc.to != "" {
					ci.To = ptr(pc.to)
				}
				in.Connectors = append(in.Connectors, ci)
			}
		}
	}
	_, err := replaceWorkflow(t, projectID, in)
	return err
}

// ensureSkill is the id of the Skill name, creating it as a generic Skill when the Organisation
// has none so named: the default Workflows' Steps carry engineer, review, triage and qa, which
// `darkory init` seeds but an Install from before model v2, or before the sample Workflows, may
// lack.
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

// WorkflowsInput is the whole graph SetWorkflow puts in place of a Project's: every Workflow, one
// at least, every Step with its Workflow, and every Connector. The order of its lists is not
// read: each one's Position says where it goes.
type WorkflowsInput struct {
	Workflows  []WorkflowInput
	Steps      []StepInput
	Connectors []ConnectorInput
	// Moves says where the Tasks at each Step left out go, the open ones and the ended ones that
	// ended at it: the deleted Step's id → a Step of the body, in any of its Workflows, by id or
	// name.
	Moves map[string]string
	// Who takes the Steps, changed in the same write: the generic Skills to create first, so a
	// Step or a grant may name one; the Members to add to the Project; the Skills to give and to
	// take away.
	Skills  []WorkflowSkill
	Joins   []string
	Grants  []SkillGrant
	Revokes []SkillGrant
}

// WorkflowSkill is a generic Skill SetWorkflow creates before it puts the Workflow in place.
type WorkflowSkill struct{ Name, Body string }

// SkillGrant names a Member and a Skill, each by id or name.
type SkillGrant struct{ Member, Skill string }

// WorkflowInput is one Workflow of the graph being set. ID names one the Project has now; left
// out, the Workflow with the same name, ignoring case, keeps its id unless another Workflow of the
// body carries it, and any other is new. Position is its place among the Workflows, 1 first,
// distinct, and they are numbered 1, 2, 3… in that order; 0 reads as its place in the list.
type WorkflowInput struct {
	ID       string
	Name     string
	Position int64
}

// StepInput is one Step of the graph being set: ID names one the Project has now, and is empty
// for a new one. Workflow names the Workflow of the body it belongs to, by id or name. Skill
// names a Skill by id or name; nil for a hold. Position is its place in its Workflow, 1 first,
// distinct among that Workflow's Steps, and they are numbered 1, 2, 3… in that order; 0 reads as
// its place in the list, for a caller that sends them in order. X and Y, when nil, keep a Step's
// place on the canvas, and put a new one at ((Position − 1) × 448, 0) in its Workflow.
type StepInput struct {
	ID       string
	Workflow string
	Name     string
	Skill    *string
	Position int64
	X, Y     *int64
}

// ConnectorInput is one Connector of the graph being set. From and To name Steps of the body by
// id or name, To in any of its Workflows; To nil is Done. ID names one the Project has now, and
// may be left out: a Connector out of the same Step with the same name keeps its id. Position is
// its place among the Connectors out of its Step, as a Step's is among its Workflow's Steps.
type ConnectorInput struct {
	ID       string
	From     string
	To       *string
	Name     string
	Position int64
}

// SetWorkflow replaces a Project's Workflows with w, its whole graph (admin), and returns them as
// GetWorkflow does, with their live facts. A Workflow left out is deleted, with the Steps the body
// leaves out; a Step left out is deleted, and the open Tasks at it go where w.Moves says, to a
// Step of any Workflow, and are refused step_in_use when it does not say. A Step's Skill and
// Workflow may change: the Tasks at it keep their place, and the next `next` reads the new Skill.
// No Workflow at all, two Workflows named alike, a Step naming a Workflow not in the body, a
// Connector naming a Step not in it, two Connectors out of one Step with one name, and two
// Workflows, two Steps of one Workflow or two Connectors out of one Step at one position are
// refused invalid. The Tasks moved keep their Claims. A Workflow may have no Steps: filing in a
// Project with none at all is then refused no_step.
func (s *Service) SetWorkflow(ctx context.Context, c *auth.Caller, projectRef string, w WorkflowsInput, idem Idem) (WorkflowsDetail, error) {
	if err := mustAdmin(c); err != nil {
		return WorkflowsDetail{}, err
	}
	if err := checkTakers(w); err != nil {
		return WorkflowsDetail{}, err
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		projectID, err := resolveProject(ctx, t, c.OrgID, projectRef)
		if err != nil {
			return nil, err
		}
		for _, sk := range w.Skills {
			if _, err := createSkill(t, sk.Name, "generic", nil, sk.Body, false); err != nil {
				return nil, err
			}
		}
		if _, err := replaceWorkflow(t, projectID, w); err != nil {
			return nil, err
		}
		if err := changeTakers(t, projectID, w); err != nil {
			return nil, err
		}
		return workflowDetail(ctx, t, c.OrgID, projectID, t.now)
	})
	if err != nil {
		return WorkflowsDetail{}, err
	}
	return res.(WorkflowsDetail), nil
}

// checkTakers refuses, before anything is written, a new Skill's name that is not one, a name
// given twice, and a Member and Skill both granted and revoked.
func checkTakers(w WorkflowsInput) error {
	named := map[string]bool{}
	for _, sk := range w.Skills {
		if !skillName.MatchString(sk.Name) || looksLikeID(sk.Name) {
			return refuse(CodeInvalid, "a Skill name is lower-case letters, digits and dashes, such as qa: %q is not", sk.Name)
		}
		if named[sk.Name] {
			return refuse(CodeInvalid, "the Skill %s is created twice", sk.Name)
		}
		named[sk.Name] = true
	}
	granted := map[SkillGrant]bool{}
	for _, g := range w.Grants {
		granted[g] = true
	}
	for _, r := range w.Revokes {
		if granted[r] {
			return refuse(CodeInvalid, "%s and %s are in both grants and revokes", r.Member, r.Skill)
		}
	}
	return nil
}

// changeTakers makes SetWorkflow's changes to who takes the Steps inside its write: the Members
// joining the Project, then the Skills given, then those taken away. Each act that changes
// nothing records nothing.
func changeTakers(t *tx, projectID string, w WorkflowsInput) error {
	ctx, org := t.ctx, t.caller.OrgID
	for _, ref := range w.Joins {
		member, err := resolveMember(ctx, t, org, ref)
		if err != nil {
			return err
		}
		if err := addProjectMember(t, projectID, member); err != nil {
			return err
		}
	}
	both := func(g SkillGrant) (string, string, error) {
		member, err := resolveMember(ctx, t, org, g.Member)
		if err != nil {
			return "", "", err
		}
		skill, err := resolveSkill(ctx, t, org, g.Skill)
		return member, skill, err
	}
	for _, g := range w.Grants {
		member, skill, err := both(g)
		if err != nil {
			return err
		}
		if err := grantSkill(t, member, skill); err != nil {
			return err
		}
	}
	for _, g := range w.Revokes {
		member, skill, err := both(g)
		if err != nil {
			return err
		}
		if err := revokeSkill(t, member, skill); err != nil {
			return err
		}
	}
	return nil
}

// resolvedWorkflow is a WorkflowsInput checked against the record: every Workflow, Step and
// Connector with its id, Skill and place, each list in the Project's order.
type resolvedWorkflow struct {
	workflows  []Workflow
	steps      []Step
	connectors []Connector
	// moves maps a deleted Step's id to the id of the Step its Tasks go to.
	moves map[string]string
}

// replaceWorkflow puts w in place of the Project's Workflows inside a write, recording
// workflow.changed, and returns them; unchanged Workflows write nothing.
func replaceWorkflow(t *tx, projectID string, w WorkflowsInput) (Workflows, error) {
	ctx, org := t.ctx, t.caller.OrgID
	current, err := getWorkflow(ctx, t, org, projectID)
	if err != nil {
		return Workflows{}, err
	}
	next, err := resolveWorkflow(t, current, w)
	if err != nil {
		return Workflows{}, err
	}
	for _, st := range next.steps {
		if st.SkillID == nil {
			continue
		}
		if err := stepSkillFits(t, projectID, *st.SkillID); err != nil {
			return Workflows{}, err
		}
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
	keptWF := map[string]bool{}
	for _, wf := range next.workflows {
		keptWF[wf.ID] = true
	}
	var deletedWF []Workflow
	for _, wf := range current.Workflows {
		if !keptWF[wf.ID] {
			deletedWF = append(deletedWF, wf)
		}
	}
	at := map[string][]string{}
	for _, st := range deleted {
		ids, err := collect(ctx, t, func(row interface{ Scan(...any) error }) (string, error) {
			var id string
			return id, row.Scan(&id)
		}, `SELECT id FROM tasks WHERE org_id = $1 AND step_id = $2 ORDER BY id`, org, st.ID)
		if err != nil {
			return Workflows{}, err
		}
		if _, ok := next.moves[st.ID]; !ok && len(ids) > 0 {
			return Workflows{}, refuse(CodeStepInUse, "%d open Tasks are at %s; say in moves which Step they go to", len(ids), st.Name)
		}
		at[st.ID] = ids
	}
	if sameWorkflow(current, next) {
		return current, nil
	}

	// Names are unique in a Project, so a rename lands only once every Workflow, and every Step,
	// there now has let go of its name: each first takes its id, which no name can be. Connectors
	// are put back whole. A kept Step takes its Workflow before a deleted Workflow goes, as it may
	// have been in one.
	if _, err := t.Exec(ctx, `DELETE FROM connectors WHERE org_id = $1 AND project_id = $2`, org, projectID); err != nil {
		return Workflows{}, err
	}
	if _, err := t.Exec(ctx, `UPDATE workflows SET name = id WHERE org_id = $1 AND project_id = $2`, org, projectID); err != nil {
		return Workflows{}, err
	}
	wasWF := map[string]bool{}
	for _, wf := range current.Workflows {
		wasWF[wf.ID] = true
	}
	for _, wf := range next.workflows {
		if wasWF[wf.ID] {
			continue
		}
		if _, err := t.Exec(ctx, `INSERT INTO workflows (id, org_id, project_id, name, position, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
			wf.ID, org, projectID, wf.ID, wf.Position, ms(t.now)); err != nil {
			return Workflows{}, err
		}
	}
	if _, err := t.Exec(ctx, `UPDATE steps SET name = id WHERE org_id = $1 AND project_id = $2`, org, projectID); err != nil {
		return Workflows{}, err
	}
	was := map[string]bool{}
	for _, st := range current.Steps {
		was[st.ID] = true
	}
	for _, st := range next.steps {
		if was[st.ID] {
			continue
		}
		if _, err := t.Exec(ctx, `INSERT INTO steps (id, org_id, project_id, workflow_id, name, skill_id, position, x, y, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, st.ID, org, projectID, st.WorkflowID, st.ID, st.SkillID, st.Position, st.X, st.Y, ms(t.now)); err != nil {
			return Workflows{}, err
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
				return Workflows{}, err
			}
			moved++
		}
		// The Tasks that ended at it follow, so each lands on the board of the Workflow it is
		// moved into; with no move, deleting the Step sets theirs null.
		if _, err := t.Exec(ctx, `UPDATE tasks SET last_step_id = $1 WHERE org_id = $2 AND last_step_id = $3`, to, org, st.ID); err != nil {
			return Workflows{}, err
		}
	}
	for _, st := range deleted {
		if _, err := t.Exec(ctx, `DELETE FROM steps WHERE org_id = $1 AND id = $2`, org, st.ID); err != nil {
			return Workflows{}, err
		}
	}
	for _, st := range next.steps {
		if _, err := t.Exec(ctx, `UPDATE steps SET name = $1, skill_id = $2, workflow_id = $3, position = $4, x = $5, y = $6 WHERE org_id = $7 AND id = $8`,
			st.Name, st.SkillID, st.WorkflowID, st.Position, st.X, st.Y, org, st.ID); err != nil {
			return Workflows{}, err
		}
	}
	for _, wf := range deletedWF {
		if _, err := t.Exec(ctx, `DELETE FROM workflows WHERE org_id = $1 AND id = $2`, org, wf.ID); err != nil {
			return Workflows{}, err
		}
	}
	for _, wf := range next.workflows {
		if _, err := t.Exec(ctx, `UPDATE workflows SET name = $1, position = $2 WHERE org_id = $3 AND id = $4`, wf.Name, wf.Position, org, wf.ID); err != nil {
			return Workflows{}, err
		}
	}
	for _, k := range next.connectors {
		if _, err := t.Exec(ctx, `INSERT INTO connectors (id, org_id, project_id, from_step_id, to_step_id, name, position, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, k.ID, org, projectID, k.FromStepID, k.ToStepID, k.Name, k.Position, ms(t.now)); err != nil {
			return Workflows{}, err
		}
	}

	after, err := getWorkflow(ctx, t, org, projectID)
	if err != nil {
		return Workflows{}, err
	}
	workflows := make([]map[string]any, len(after.Workflows))
	for i, wf := range after.Workflows {
		workflows[i] = map[string]any{"id": wf.ID, "name": wf.Name, "position": wf.Position}
	}
	steps := make([]map[string]any, len(after.Steps))
	for i, st := range after.Steps {
		steps[i] = map[string]any{"id": st.ID, "workflow_id": st.WorkflowID, "name": st.Name, "skill_id": st.SkillID, "position": st.Position}
	}
	connectors := make([]map[string]any, len(after.Connectors))
	for i, k := range after.Connectors {
		connectors[i] = map[string]any{"id": k.ID, "from": k.FromStepID, "to": k.ToStepID, "name": k.Name}
	}
	payload := map[string]any{"workflows": workflows, "steps": steps, "connectors": connectors}
	if len(next.moves) > 0 {
		payload["moves"], payload["tasks_moved"] = next.moves, moved
	}
	if err := t.recordByCaller("workflow.changed", projectID, payload); err != nil {
		return Workflows{}, err
	}
	return after, nil
}

// resolveWorkflows checks the body's Workflows on their own and against the Project's now, and
// returns them with their ids and places, by position.
func resolveWorkflows(current Workflows, in []WorkflowInput) ([]Workflow, error) {
	if len(in) == 0 {
		return nil, refuse(CodeInvalid, "no Workflow at all; a Project has one at least")
	}
	at, err := places("two Workflows", "a Workflow", len(in), func(i int) int64 { return in[i].Position })
	if err != nil {
		return nil, err
	}
	out := make([]Workflow, len(in))
	names := map[string]bool{}
	given := map[string]bool{}
	for i, wi := range in {
		name := strings.TrimSpace(wi.Name)
		if err := validWorkflowName("a Workflow's name", name); err != nil {
			return nil, err
		}
		if names[strings.ToLower(name)] {
			return nil, refuse(CodeInvalid, "two Workflows are named %q; names are unique, ignoring case", name)
		}
		names[strings.ToLower(name)] = true
		out[i] = Workflow{Name: name, Position: at[i]}
		if wi.ID == "" {
			continue
		}
		id := shortid.Canonical(wi.ID) // either form (ADR 0017)
		if !slices.ContainsFunc(current.Workflows, func(wf Workflow) bool { return wf.ID == id }) {
			return nil, refuse(CodeInvalid, "the Project has no Workflow %s; a new Workflow has no id", id)
		}
		if given[id] {
			return nil, refuse(CodeInvalid, "Workflow %s is in the body twice", id)
		}
		given[id] = true
		out[i].ID = id
	}
	// A Workflow sent without its id keeps the id of the one with its name, so a body put back as
	// read, or a preset run again, is unchanged; unless another Workflow of the body carries that
	// id, as when Work is renamed and a new Work added in one write.
	for i := range out {
		if out[i].ID != "" {
			continue
		}
		for _, cur := range current.Workflows {
			if !given[cur.ID] && strings.EqualFold(cur.Name, out[i].Name) {
				out[i].ID, given[cur.ID] = cur.ID, true
				break
			}
		}
		if out[i].ID == "" {
			out[i].ID = newID()
		}
	}
	slices.SortFunc(out, func(a, b Workflow) int { return cmp.Compare(a.Position, b.Position) })
	return out, nil
}

// resolveWorkflow checks w on its own and against the Workflows it replaces and the Skills.
func resolveWorkflow(t *tx, current Workflows, w WorkflowsInput) (resolvedWorkflow, error) {
	var out resolvedWorkflow
	var err error
	if out.workflows, err = resolveWorkflows(current, w.Workflows); err != nil {
		return out, err
	}
	body := Workflows{Workflows: out.workflows}
	wfPos := map[string]int64{}
	for _, wf := range out.workflows {
		wfPos[wf.ID] = wf.Position
	}

	// Each Step's Workflow, then each Workflow's Steps take their places among themselves.
	stepWF := make([]Workflow, len(w.Steps))
	group := map[string][]int{}
	for i, in := range w.Steps {
		wf, ok := body.findWorkflow(in.Workflow)
		if !ok {
			return out, refuse(CodeInvalid, "a Step names %q, which is not a Workflow of the body", in.Workflow)
		}
		stepWF[i] = wf
		group[wf.ID] = append(group[wf.ID], i)
	}
	stepAt := make([]int64, len(w.Steps))
	for _, wf := range out.workflows {
		is := group[wf.ID]
		at, err := places("two Steps in "+wf.Name, "a Step in "+wf.Name, len(is), func(j int) int64 { return w.Steps[is[j]].Position })
		if err != nil {
			return out, err
		}
		for j, i := range is {
			stepAt[i] = at[j]
		}
	}

	names := map[string]bool{}
	ids := map[string]bool{}
	for i, in := range w.Steps {
		name := strings.TrimSpace(in.Name)
		if err := validWorkflowName("a Step's name", name); err != nil {
			return out, err
		}
		if names[strings.ToLower(name)] {
			return out, refuse(CodeInvalid, "two Steps are named %q; names are unique, ignoring case", name)
		}
		names[strings.ToLower(name)] = true
		id := shortid.Canonical(in.ID) // either form (ADR 0017)
		st := Step{ID: id, WorkflowID: stepWF[i].ID, Name: name, Position: stepAt[i], X: (stepAt[i] - 1) * stepSpacing}
		if id != "" {
			j := slices.IndexFunc(current.Steps, func(s Step) bool { return s.ID == id })
			if j < 0 {
				return out, refuse(CodeInvalid, "the Project has no Step %s; a new Step has no id", id)
			}
			if ids[id] {
				return out, refuse(CodeInvalid, "Step %s is in the body twice", id)
			}
			ids[id] = true
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
	// The Project's order: the Workflow's place, then the Step's.
	slices.SortFunc(out.steps, func(a, b Step) int {
		return cmp.Or(cmp.Compare(wfPos[a.WorkflowID], wfPos[b.WorkflowID]), cmp.Compare(a.Position, b.Position))
	})
	next := Workflows{Workflows: out.workflows, Steps: out.steps}
	find := func(what, ref string) (string, error) {
		st, ok := next.find(ref)
		if !ok {
			return "", refuse(CodeInvalid, "%s names %q, which is not a Step of the body", what, ref)
		}
		return st.ID, nil
	}

	claimed := map[string]bool{}
	for _, in := range w.Connectors {
		if id := shortid.Canonical(in.ID); id != "" { // either form (ADR 0017)
			if !slices.ContainsFunc(current.Connectors, func(k Connector) bool { return k.ID == id }) {
				return out, refuse(CodeInvalid, "the Project has no Connector %s; a new Connector has no id", id)
			}
			if claimed[id] {
				return out, refuse(CodeInvalid, "Connector %s is in the body twice", id)
			}
			claimed[id] = true
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
		k := Connector{ID: shortid.Canonical(in.ID), FromStepID: from, Name: name}
		if in.To != nil {
			// Into any Step of the body, of the Step's Workflow or of another.
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
			// A Connector sent back without its id keeps it, so Workflows put back as read are
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
	// Each Step's Connectors take their places among themselves, in the Project's order of Steps.
	at := map[string][]int64{}
	for from, ps := range given {
		st, _ := next.find(from)
		if at[from], err = places("two Connectors out of "+st.Name, "a Connector out of "+st.Name, len(ps), func(i int) int64 { return ps[i] }); err != nil {
			return out, err
		}
	}
	seen := map[string]int{}
	for i := range out.connectors {
		from := out.connectors[i].FromStepID
		out.connectors[i].Position = at[from][seen[from]]
		seen[from]++
	}
	order := map[string]int{}
	for i, st := range out.steps {
		order[st.ID] = i
	}
	slices.SortFunc(out.connectors, func(a, b Connector) int {
		return cmp.Or(cmp.Compare(order[a.FromStepID], order[b.FromStepID]), cmp.Compare(a.Position, b.Position))
	})

	out.moves = map[string]string{}
	for given, to := range w.Moves {
		from := shortid.Canonical(given) // either form (ADR 0017)
		if ids[from] || !slices.ContainsFunc(current.Steps, func(s Step) bool { return s.ID == from }) {
			return out, refuse(CodeInvalid, "moves names %s, which is not a Step being deleted", from)
		}
		if _, twice := out.moves[from]; twice { // its long and short forms both given
			return out, refuse(CodeInvalid, "moves names Step %s twice", from)
		}
		id, err := find("moves", to)
		if err != nil {
			return out, err
		}
		out.moves[from] = id
	}
	return out, nil
}

// places numbers n Workflows, the n Steps of one Workflow, or the n Connectors out of one Step, 1
// to n in the order of their positions, pos(i) for the i-th in the list; a position of 0 reads as
// its place in the list. Two at one position, or one below 0, are refused invalid; what names
// two of them and one names one, for the refusals.
func places(what, one string, n int, pos func(i int) int64) ([]int64, error) {
	given := make([]int64, n)
	order := make([]int, n)
	taken := map[int64]bool{}
	for i := range n {
		given[i], order[i] = pos(i), i
		if given[i] < 0 {
			return nil, refuse(CodeInvalid, "the position of %s is 1 or more, or left out, not %d", one, given[i])
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

// sameWorkflow reports whether next is the Project's Workflows as they are.
func sameWorkflow(current Workflows, next resolvedWorkflow) bool {
	if len(next.moves) > 0 || len(current.Workflows) != len(next.workflows) || len(current.Steps) != len(next.steps) ||
		len(current.Connectors) != len(next.connectors) {
		return false
	}
	for i, wf := range next.workflows {
		if cur := current.Workflows[i]; wf.ID != cur.ID || wf.Name != cur.Name || wf.Position != cur.Position {
			return false
		}
	}
	for i, st := range next.steps {
		cur := current.Steps[i]
		if st.ID != cur.ID || st.WorkflowID != cur.WorkflowID || st.Name != cur.Name || !sameRef(st.SkillID, cur.SkillID) ||
			st.Position != cur.Position || st.X != cur.X || st.Y != cur.Y {
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

// GetWorkflow returns a Project's Workflows, with the live facts of each Step.
func (s *Service) GetWorkflow(ctx context.Context, c *auth.Caller, projectRef string) (WorkflowsDetail, error) {
	projectID, err := resolveProject(ctx, s.store, c.OrgID, projectRef)
	if err != nil {
		return WorkflowsDetail{}, err
	}
	return workflowDetail(ctx, s.store, c.OrgID, projectID, s.clock.Now())
}

// workflowDetail reads a Project's Workflows, with the live facts of each Step as of now.
func workflowDetail(ctx context.Context, r store.Reader, orgID, projectID string, now time.Time) (WorkflowsDetail, error) {
	w, err := getWorkflow(ctx, r, orgID, projectID)
	if err != nil {
		return WorkflowsDetail{}, err
	}
	d := WorkflowsDetail{Workflows: w, Facts: make([]StepFacts, len(w.Steps))}
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

// copiedSkill is the Skill a copied Step carries in a new Project: the one it carries, unless that
// is a company Skill belonging to the Project copied, which no other Project's Step may carry;
// the copy then carries the generic Skill it builds on.
func copiedSkill(t *tx, skillID *string) (*string, error) {
	if skillID == nil {
		return nil, nil
	}
	sk, err := getSkill(t.ctx, t, t.caller.OrgID, *skillID)
	if err != nil {
		return nil, err
	}
	if sk.ProjectID != nil {
		return sk.BaseSkillID, nil
	}
	return skillID, nil
}
