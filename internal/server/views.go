package server

import (
	"net/http"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/server/gen"
)

// A Member's own Views of the Tasks list, across Projects or of one Project's.

func viewOut(v core.View) gen.View {
	out := gen.View{ID: v.ID, Entity: gen.ViewEntity(v.Entity), ProjectID: v.ProjectID, Name: v.Name, Filters: v.Filters, Sort: v.Sort,
		CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
	if v.Display != nil {
		out.Display = &v.Display
	}
	return out
}

func (s *Server) ListViews(w http.ResponseWriter, r *http.Request, params gen.ListViewsParams) {
	vs, err := s.core.ListViews(r.Context(), caller(r), (*string)(params.Entity), params.Project)
	s.respond(w, r, as(http.StatusOK, func(vs []core.View) any { return gen.ViewList{Items: each(vs, viewOut)} }), vs, err)
}

func (s *Server) CreateView(w http.ResponseWriter, r *http.Request, params gen.CreateViewParams) {
	var body gen.CreateViewBody
	out := as(http.StatusCreated, func(v core.View) any { return viewOut(v) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	nv := core.NewView{Entity: string(body.Entity), Project: body.Project, Name: body.Name, Sort: body.Sort}
	if body.Filters != nil {
		nv.Filters = *body.Filters
	}
	if body.Display != nil {
		nv.Display = *body.Display
	}
	v, err := s.core.CreateView(r.Context(), c, nv, idem)
	s.respond(w, r, out, v, err)
}

func (s *Server) UpdateView(w http.ResponseWriter, r *http.Request, view gen.ViewID, params gen.UpdateViewParams) {
	var body gen.UpdateViewBody
	out := as(http.StatusOK, func(v core.View) any { return viewOut(v) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	ch := core.ViewChange{Name: body.Name, Filters: body.Filters, Sort: body.Sort}
	if body.Display != nil {
		ch.Display = *body.Display
	}
	v, err := s.core.UpdateView(r.Context(), c, view, ch, idem)
	s.respond(w, r, out, v, err)
}

func (s *Server) DeleteView(w http.ResponseWriter, r *http.Request, view gen.ViewID, params gen.DeleteViewParams) {
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, nil, noContent)
	if !ok {
		return
	}
	s.respond(w, r, noContent, nil, s.core.DeleteView(r.Context(), c, view, idem))
}
