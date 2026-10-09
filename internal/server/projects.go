package server

import (
	"net/http"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/server/gen"
	"github.com/tuongaz/darkory/internal/shortid"
)

// Projects with their Members and Workflows (ADR 0015, ADR 0016), and Labels.

func (s *Server) ListProjects(w http.ResponseWriter, r *http.Request) {
	ps, err := s.core.ListProjects(r.Context(), caller(r))
	s.respond(w, r, as(http.StatusOK, func(ps []core.Project) any { return gen.ProjectList{Items: each(ps, projectOut)} }), ps, err)
}

func (s *Server) CreateProject(w http.ResponseWriter, r *http.Request, params gen.CreateProjectParams) {
	var body gen.CreateProjectBody
	out := as(http.StatusCreated, func(d core.ProjectDetail) any { return projectDetailOut(d) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	np := core.NewProject{Key: body.Key, Name: body.Name, Color: body.Color, CopyFrom: body.CopyFrom, DefaultWorkspace: body.DefaultWorkspace,
		AutoComplete: body.AutoComplete, Acceptance: body.Acceptance}
	if body.Workflow != nil {
		np.Workflow = string(*body.Workflow)
	}
	if body.Members != nil {
		np.Members = *body.Members
	}
	d, err := s.core.CreateProject(r.Context(), c, np, idem)
	s.respond(w, r, out, d, err)
}

func (s *Server) GetProject(w http.ResponseWriter, r *http.Request, project gen.ProjectRef) {
	d, err := s.core.GetProject(r.Context(), caller(r), project)
	s.respond(w, r, as(http.StatusOK, func(d core.ProjectDetail) any { return projectDetailOut(d) }), d, err)
}

func (s *Server) UpdateProject(w http.ResponseWriter, r *http.Request, project gen.ProjectRef, params gen.UpdateProjectParams) {
	var body gen.UpdateProjectBody
	out := as(http.StatusOK, func(p core.Project) any { return projectOut(p) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	p, err := s.core.UpdateProject(r.Context(), c, project, core.ProjectChange{Name: body.Name, Color: body.Color, DefaultWorkspace: body.DefaultWorkspace,
		AutoComplete: body.AutoComplete, Acceptance: body.Acceptance}, idem)
	s.respond(w, r, out, p, err)
}

func (s *Server) AddProjectMember(w http.ResponseWriter, r *http.Request, project gen.ProjectRef, member gen.MemberRef, params gen.AddProjectMemberParams) {
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, nil, noContent)
	if !ok {
		return
	}
	s.respond(w, r, noContent, nil, s.core.AddProjectMember(r.Context(), c, project, member, idem))
}

func (s *Server) RemoveProjectMember(w http.ResponseWriter, r *http.Request, project gen.ProjectRef, member gen.MemberRef, params gen.RemoveProjectMemberParams) {
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, nil, noContent)
	if !ok {
		return
	}
	s.respond(w, r, noContent, nil, s.core.RemoveProjectMember(r.Context(), c, project, member, idem))
}

func (s *Server) GetWorkflow(w http.ResponseWriter, r *http.Request, project gen.ProjectRef) {
	d, err := s.core.GetWorkflow(r.Context(), caller(r), project)
	s.respond(w, r, as(http.StatusOK, func(d core.WorkflowsDetail) any { return workflowOut(d) }), d, err)
}

// SetWorkflow replaces a Project's Workflows and answers with it as getWorkflow does, live facts
// included, read in the same write.
func (s *Server) SetWorkflow(w http.ResponseWriter, r *http.Request, project gen.ProjectRef, params gen.SetWorkflowParams) {
	var body gen.SetWorkflowBody
	out := as(http.StatusOK, func(d core.WorkflowsDetail) any { return workflowOut(d) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	in := core.WorkflowsInput{
		Workflows: each(body.Workflows, func(wf gen.WorkflowInput) core.WorkflowInput {
			return core.WorkflowInput{ID: deref(shortid.StringPtr(wf.ID)), Name: wf.Name, Position: wf.Position}
		}),
		Steps: each(body.Steps, func(st gen.StepInput) core.StepInput {
			return core.StepInput{ID: deref(shortid.StringPtr(st.ID)), Workflow: st.Workflow, Name: st.Name, Skill: st.Skill, Position: st.Position, X: st.X, Y: st.Y}
		}),
		Connectors: each(body.Connectors, func(k gen.ConnectorInput) core.ConnectorInput {
			return core.ConnectorInput{ID: deref(shortid.StringPtr(k.ID)), From: k.From, To: k.To, Name: k.Name, Position: k.Position}
		}),
	}
	if body.Moves != nil {
		in.Moves = *body.Moves
	}
	grant := func(g gen.SkillGrantInput) core.SkillGrant { return core.SkillGrant{Member: g.Member, Skill: g.Skill} }
	if body.Skills != nil {
		in.Skills = each(*body.Skills, func(k gen.WorkflowSkillInput) core.WorkflowSkill {
			return core.WorkflowSkill{Name: k.Name, Body: k.Body}
		})
	}
	if body.Joins != nil {
		in.Joins = *body.Joins
	}
	if body.Grants != nil {
		in.Grants = each(*body.Grants, grant)
	}
	if body.Revokes != nil {
		in.Revokes = each(*body.Revokes, grant)
	}
	d, err := s.core.SetWorkflow(r.Context(), c, project, in, idem)
	s.respond(w, r, out, d, err)
}

func labelList(ls []core.Label) any { return gen.LabelList{Items: each(ls, labelOut)} }

func (s *Server) ListLabels(w http.ResponseWriter, r *http.Request) {
	ls, err := s.core.ListLabels(r.Context(), caller(r), nil)
	s.respond(w, r, as(http.StatusOK, labelList), ls, err)
}

func (s *Server) ListProjectLabels(w http.ResponseWriter, r *http.Request, project gen.ProjectRef) {
	ls, err := s.core.ListLabels(r.Context(), caller(r), &project)
	s.respond(w, r, as(http.StatusOK, labelList), ls, err)
}

func (s *Server) CreateLabel(w http.ResponseWriter, r *http.Request, params gen.CreateLabelParams) {
	s.createLabel(w, r, nil, params.IdempotencyKey)
}

func (s *Server) CreateProjectLabel(w http.ResponseWriter, r *http.Request, project gen.ProjectRef, params gen.CreateProjectLabelParams) {
	s.createLabel(w, r, &project, params.IdempotencyKey)
}

// createLabel defines a Label for the Project project names, or for the Organisation when nil.
func (s *Server) createLabel(w http.ResponseWriter, r *http.Request, project *string, key *string) {
	var body gen.CreateLabelBody
	out := as(http.StatusCreated, func(l core.Label) any { return labelOut(l) })
	c, idem, ok := s.begin(w, r, key, &body, out)
	if !ok {
		return
	}
	l, err := s.core.CreateLabel(r.Context(), c, core.NewLabel{Project: project, Name: body.Name, Color: body.Color}, idem)
	s.respond(w, r, out, l, err)
}

func (s *Server) UpdateLabel(w http.ResponseWriter, r *http.Request, label gen.LabelID, params gen.UpdateLabelParams) {
	var body gen.UpdateLabelBody
	out := as(http.StatusOK, func(l core.Label) any { return labelOut(l) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	l, err := s.core.UpdateLabel(r.Context(), c, string(label), core.LabelChange{Name: body.Name, Color: body.Color}, idem)
	s.respond(w, r, out, l, err)
}

func (s *Server) DeleteLabel(w http.ResponseWriter, r *http.Request, label gen.LabelID, params gen.DeleteLabelParams) {
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, nil, noContent)
	if !ok {
		return
	}
	s.respond(w, r, noContent, nil, s.core.DeleteLabel(r.Context(), c, string(label), idem))
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
