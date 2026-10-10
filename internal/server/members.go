package server

import (
	"net/http"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/server/gen"
	"github.com/tuongaz/darkory/internal/shortid"
)

// GetMe returns the caller, their Projects and Skills, and the Session making the request; the
// Organisations the sign-in reaches only where there can be more than one (never on Local).
func (s *Server) GetMe(w http.ResponseWriter, r *http.Request) {
	me, err := s.core.GetMe(r.Context(), caller(r))
	s.respond(w, r, as(http.StatusOK, func(me core.Me) any {
		out := gen.Me{
			Organisation: gen.Organisation{ID: shortid.Of(me.Organisation.ID), Name: me.Organisation.Name, CreatedAt: me.Organisation.CreatedAt},
			Member:       memberOut(me.Member), Projects: each(me.Projects, projectOut), Skills: each(me.Skills, skillOut),
			Session: sessionOut(me.Session),
		}
		if me.Organisations != nil {
			orgs := each(me.Organisations, func(o core.Organisation) gen.OrganisationBrief {
				return gen.OrganisationBrief{ID: shortid.Of(o.ID), Name: o.Name}
			})
			out.Organisations = &orgs
		}
		return out
	}), me, err)
}

func (s *Server) CreateMember(w http.ResponseWriter, r *http.Request, params gen.CreateMemberParams) {
	var body gen.CreateMemberBody
	out := as(http.StatusCreated, func(m core.Member) any { return memberOut(m) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	nm := core.NewMember{Name: body.Name, Kind: string(body.Kind), Email: (*string)(body.Email)}
	if body.Admin != nil {
		nm.Admin = *body.Admin
	}
	m, err := s.core.CreateMember(r.Context(), c, nm, idem)
	s.respond(w, r, out, m, err)
}

func (s *Server) DeactivateMember(w http.ResponseWriter, r *http.Request, member gen.MemberRef, params gen.DeactivateMemberParams) {
	out := as(http.StatusOK, func(m core.Member) any { return memberOut(m) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, nil, out)
	if !ok {
		return
	}
	m, err := s.core.DeactivateMember(r.Context(), c, member, idem)
	s.respond(w, r, out, m, err)
}

func (s *Server) ReactivateMember(w http.ResponseWriter, r *http.Request, member gen.MemberRef, params gen.ReactivateMemberParams) {
	out := as(http.StatusOK, func(m core.Member) any { return memberOut(m) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, nil, out)
	if !ok {
		return
	}
	m, err := s.core.ReactivateMember(r.Context(), c, member, idem)
	s.respond(w, r, out, m, err)
}

func (s *Server) ListMembers(w http.ResponseWriter, r *http.Request, params gen.ListMembersParams) {
	ms, err := s.core.ListMembers(r.Context(), caller(r), params.Project, (*string)(params.Kind))
	s.respond(w, r, as(http.StatusOK, func(ms []core.Member) any { return gen.MemberList{Items: each(ms, memberOut)} }), ms, err)
}

func (s *Server) GetMember(w http.ResponseWriter, r *http.Request, member gen.MemberRef) {
	d, err := s.core.GetMember(r.Context(), caller(r), member)
	s.respond(w, r, as(http.StatusOK, func(d core.MemberDetail) any { return memberDetailOut(d) }), d, err)
}

func (s *Server) UpdateMember(w http.ResponseWriter, r *http.Request, member gen.MemberRef, params gen.UpdateMemberParams) {
	var body gen.UpdateMemberBody
	out := as(http.StatusOK, func(m core.Member) any { return memberOut(m) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	m, err := s.core.UpdateMember(r.Context(), c, member, core.MemberChange{Name: body.Name, Email: (*string)(body.Email), Admin: body.Admin,
		AvatarFileID: shortid.StringPtr(body.AvatarFileID)}, idem)
	if err == nil && body.AvatarFileID != nil {
		// An avatar file the Member stopped showing was deleted with the change.
		s.purgeFiles(r.Context(), c)
	}
	s.respond(w, r, out, m, err)
}

func (s *Server) GrantSkill(w http.ResponseWriter, r *http.Request, member gen.MemberRef, skill gen.SkillRef, params gen.GrantSkillParams) {
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, nil, noContent)
	if !ok {
		return
	}
	s.respond(w, r, noContent, nil, s.core.GrantSkill(r.Context(), c, member, skill, idem))
}

func (s *Server) RevokeSkill(w http.ResponseWriter, r *http.Request, member gen.MemberRef, skill gen.SkillRef, params gen.RevokeSkillParams) {
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, nil, noContent)
	if !ok {
		return
	}
	s.respond(w, r, noContent, nil, s.core.RevokeSkill(r.Context(), c, member, skill, idem))
}

func (s *Server) SetManager(w http.ResponseWriter, r *http.Request, member gen.MemberRef, params gen.SetManagerParams) {
	var body gen.SetManagerBody
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, noContent)
	if !ok {
		return
	}
	s.respond(w, r, noContent, nil, s.core.SetManager(r.Context(), c, member, body.Manager, idem))
}

func (s *Server) ClearManager(w http.ResponseWriter, r *http.Request, member gen.MemberRef, params gen.ClearManagerParams) {
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, nil, noContent)
	if !ok {
		return
	}
	s.respond(w, r, noContent, nil, s.core.ClearManager(r.Context(), c, member, idem))
}

func (s *Server) CreateSkill(w http.ResponseWriter, r *http.Request, params gen.CreateSkillParams) {
	var body gen.CreateSkillBody
	out := as(http.StatusCreated, func(d core.SkillDetail) any { return skillDetailOut(d) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	d, err := s.core.CreateSkill(r.Context(), c, core.NewSkill{Name: body.Name, Kind: string(body.Kind), BaseSkill: body.BaseSkill,
		Project: body.Project, Body: body.Body}, idem)
	s.respond(w, r, out, d, err)
}

func (s *Server) UpdateSkill(w http.ResponseWriter, r *http.Request, skill gen.SkillRef, params gen.UpdateSkillParams) {
	var body gen.UpdateSkillBody
	out := as(http.StatusOK, func(d core.SkillDetail) any { return skillDetailOut(d) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	d, err := s.core.UpdateSkill(r.Context(), c, skill, body.Project, idem)
	s.respond(w, r, out, d, err)
}

func (s *Server) ListSkills(w http.ResponseWriter, r *http.Request, params gen.ListSkillsParams) {
	ss, err := s.core.ListSkills(r.Context(), caller(r), (*string)(params.Kind))
	s.respond(w, r, as(http.StatusOK, func(ss []core.Skill) any { return gen.SkillList{Items: each(ss, skillOut)} }), ss, err)
}

func (s *Server) GetSkill(w http.ResponseWriter, r *http.Request, skill gen.SkillRef) {
	d, err := s.core.GetSkill(r.Context(), caller(r), skill)
	s.respond(w, r, as(http.StatusOK, func(d core.SkillDetail) any { return skillDetailOut(d) }), d, err)
}

func (s *Server) ListSkillVersions(w http.ResponseWriter, r *http.Request, skill gen.SkillRef) {
	vs, err := s.core.ListSkillVersions(r.Context(), caller(r), skill)
	s.respond(w, r, as(http.StatusOK, func(vs []core.SkillVersion) any {
		return gen.SkillVersionList{Items: each(vs, skillVersionOut)}
	}), vs, err)
}
