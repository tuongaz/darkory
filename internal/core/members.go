package core

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/tuongaz/darkory/internal/auth"
)

func validName(what, name string) error {
	if strings.TrimSpace(name) == "" || utf8.RuneCountInString(name) > 100 {
		return refuse(CodeInvalid, "%s must be 1 to 100 characters", what)
	}
	return nil
}

// looksLikeID reports whether a name is spelled as an id is, which would make a reference to it
// ambiguous: references take an id or a name (decisions.md).
func looksLikeID(name string) bool {
	u, err := uuid.Parse(name)
	return err == nil && u.String() == name
}

// validMemberName is validName, refusing a name spelled as an id.
func validMemberName(what, name string) error {
	if looksLikeID(name) {
		return refuse(CodeInvalid, "%s cannot be spelled as an id", what)
	}
	return validName(what, name)
}

// NewMember is a Member to create.
type NewMember struct {
	Name  string
	Kind  string
	Email *string
	Admin bool
}

// CreateMember creates a Member (admin).
func (s *Service) CreateMember(ctx context.Context, c *auth.Caller, nm NewMember, idem Idem) (Member, error) {
	if err := mustAdmin(c); err != nil {
		return Member{}, err
	}
	if err := validMemberName("name", nm.Name); err != nil {
		return Member{}, err
	}
	if nm.Kind != "human" && nm.Kind != "agent" {
		return Member{}, refuse(CodeInvalid, "kind must be human or agent")
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		id, err := createMember(t, nm)
		if err != nil {
			return nil, err
		}
		return getMember(ctx, t, c.OrgID, id)
	})
	if err != nil {
		return Member{}, err
	}
	return res.(Member), nil
}

// createMember creates a Member inside a write and records member.created.
func createMember(t *tx, nm NewMember) (string, error) {
	if err := nameFree(t, "", nm.Name, nm.Email); err != nil {
		return "", err
	}
	id := newID()
	if _, err := t.Exec(t.ctx, `INSERT INTO members (id, org_id, name, kind, email, admin, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`, id, t.caller.OrgID, nm.Name, nm.Kind, nm.Email, nm.Admin, ms(t.now)); err != nil {
		return "", err
	}
	return id, t.recordByCaller("member.created", id, map[string]any{"name": nm.Name, "kind": nm.Kind, "admin": nm.Admin})
}

// nameFree refuses a name or email another Member (not except) already has.
func nameFree(t *tx, except, name string, email *string) error {
	var n int
	if err := t.QueryRow(t.ctx, `SELECT COUNT(*) FROM members WHERE org_id = $1 AND name = $2 AND id <> $3`,
		t.caller.OrgID, name, except).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return refuse(CodeConflict, "a Member is already named %q", name)
	}
	if email != nil {
		if err := t.QueryRow(t.ctx, `SELECT COUNT(*) FROM members WHERE org_id = $1 AND email = $2 AND id <> $3`,
			t.caller.OrgID, *email, except).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			return refuse(CodeConflict, "a Member already has the email %q", *email)
		}
	}
	return nil
}

// MemberChange is what UpdateMember changes; nil fields stay as they are.
type MemberChange struct {
	Name  *string
	Email *string
	Admin *bool
	// AvatarFileID sets the Member's avatar to a file uploaded as one; "" removes it.
	AvatarFileID *string
}

// UpdateMember changes a Member's name, email, admin mark or avatar. An admin changes any of
// them; a human changes their own avatar too. The last admin keeps the mark. An avatar file the
// Member no longer shows, and no other Member shows, is deleted with the change.
func (s *Service) UpdateMember(ctx context.Context, c *auth.Caller, ref string, ch MemberChange, idem Idem) (Member, error) {
	onlyAvatar := ch.Name == nil && ch.Email == nil && ch.Admin == nil && ch.AvatarFileID != nil
	if !onlyAvatar {
		if err := mustAdmin(c); err != nil {
			return Member{}, err
		}
	}
	if ch.Name != nil {
		if err := validMemberName("name", *ch.Name); err != nil {
			return Member{}, err
		}
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		id, err := resolveMember(ctx, t, c.OrgID, ref)
		if err != nil {
			return nil, err
		}
		m, err := getMember(ctx, t, c.OrgID, id)
		if err != nil {
			return nil, err
		}
		if !c.Admin && (id != c.MemberID || m.Kind != "human") {
			return nil, refuse(CodeForbidden, "only an admin may change another Member's avatar, or an agent's")
		}
		payload := map[string]any{}
		name := m.Name
		if ch.Name != nil && *ch.Name != m.Name {
			name, payload["name"] = *ch.Name, *ch.Name
		}
		email := m.Email
		if ch.Email != nil && (m.Email == nil || *ch.Email != *m.Email) {
			email, payload["email"] = ch.Email, *ch.Email
		}
		admin := m.Admin
		if ch.Admin != nil && *ch.Admin != m.Admin {
			admin, payload["admin"] = *ch.Admin, *ch.Admin
		}
		avatar := m.AvatarFileID
		if ch.AvatarFileID != nil && (m.AvatarFileID == nil || *ch.AvatarFileID != *m.AvatarFileID) {
			if *ch.AvatarFileID == "" {
				if m.AvatarFileID != nil {
					avatar, payload["avatar_file_id"] = nil, nil
				}
			} else {
				if err := avatarFile(ctx, t, c, *ch.AvatarFileID); err != nil {
					return nil, err
				}
				avatar, payload["avatar_file_id"] = ch.AvatarFileID, *ch.AvatarFileID
			}
		}
		if len(payload) == 0 {
			return m, nil
		}
		if err := nameFree(t, id, name, email); err != nil {
			return nil, err
		}
		if m.Admin && !admin {
			var n int
			if err := otherActiveAdmins(t, id, &n); err != nil {
				return nil, err
			}
			if n == 0 {
				return nil, refuse(CodeConflict, "%s is the last active admin", m.Name)
			}
		}
		if _, err := t.Exec(ctx, `UPDATE members SET name = $1, email = $2, admin = $3, avatar_file_id = $4, updated_at = $5 WHERE org_id = $6 AND id = $7`,
			name, email, admin, avatar, ms(t.now), c.OrgID, id); err != nil {
			return nil, err
		}
		if err := t.recordByCaller("member.updated", id, payload); err != nil {
			return nil, err
		}
		if _, changed := payload["avatar_file_id"]; changed && m.AvatarFileID != nil {
			if err := releaseAvatar(t, *m.AvatarFileID); err != nil {
				return nil, err
			}
		}
		return getMember(ctx, t, c.OrgID, id)
	})
	if err != nil {
		return Member{}, err
	}
	return res.(Member), nil
}

// ListMembers lists the Members, by name, optionally of one Project or one kind.
func (s *Service) ListMembers(ctx context.Context, c *auth.Caller, project, kind *string) ([]Member, error) {
	q := `SELECT ` + memberCols + ` FROM ` + memberFrom + ` WHERE m.org_id = $1`
	args := []any{c.OrgID}
	if project != nil {
		id, err := resolveProject(ctx, s.store, c.OrgID, *project)
		if err != nil {
			return nil, err
		}
		args = append(args, id)
		q += ` AND m.id IN (SELECT member_id FROM project_members WHERE org_id = $1 AND project_id = $2)`
	}
	if kind != nil {
		args = append(args, *kind)
		q += ` AND m.kind = $` + itoa(len(args))
	}
	return collect(ctx, s.store, scanMember, q+` ORDER BY m.name`, args...)
}

// GetMember returns a Member with their Projects, Skills and the Members they direct.
func (s *Service) GetMember(ctx context.Context, c *auth.Caller, ref string) (MemberDetail, error) {
	id, err := resolveMember(ctx, s.store, c.OrgID, ref)
	if err != nil {
		return MemberDetail{}, err
	}
	return getMemberDetail(ctx, s.store, c.OrgID, id)
}

// SetManager sets the Member who directs a Member (admin), refusing a Reporting line that loops.
func (s *Service) SetManager(ctx context.Context, c *auth.Caller, ref, managerRef string, idem Idem) error {
	if err := mustAdmin(c); err != nil {
		return err
	}
	_, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		id, err := resolveMember(ctx, t, c.OrgID, ref)
		if err != nil {
			return nil, err
		}
		manager, err := resolveMember(ctx, t, c.OrgID, managerRef)
		if err != nil {
			return nil, err
		}
		return nil, setManager(t, id, manager, ref, managerRef)
	})
	return err
}

// setManager sets the Member who directs id inside a write, refusing a Reporting line that loops
// (named in the refusal as ref and managerRef), and records member.manager_set.
func setManager(t *tx, id, manager, ref, managerRef string) error {
	ctx, orgID := t.ctx, t.caller.OrgID
	// Walk up from the new manager; reaching the Member would close a loop.
	for m, steps := manager, 0; m != ""; steps++ {
		if m == id {
			return refuse(CodeCycle, "%s cannot report to %s: the Reporting line would loop", ref, managerRef)
		}
		if steps > 10000 {
			return refuse(CodeCycle, "the Reporting line above %s already loops", managerRef)
		}
		var up sql.NullString
		err := t.QueryRow(ctx, `SELECT manager_id FROM reporting_lines WHERE org_id = $1 AND member_id = $2`, orgID, m).Scan(&up)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		m = up.String
	}
	var current sql.NullString
	err := t.QueryRow(ctx, `SELECT manager_id FROM reporting_lines WHERE org_id = $1 AND member_id = $2`, orgID, id).Scan(&current)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if current.String == manager {
		return nil
	}
	if _, err := t.Exec(ctx, `DELETE FROM reporting_lines WHERE org_id = $1 AND member_id = $2`, orgID, id); err != nil {
		return err
	}
	if _, err := t.Exec(ctx, `INSERT INTO reporting_lines (org_id, member_id, manager_id, set_by, set_at) VALUES ($1, $2, $3, $4, $5)`,
		orgID, id, manager, t.caller.MemberID, ms(t.now)); err != nil {
		return err
	}
	return t.recordByCaller("member.manager_set", id, map[string]any{"manager_id": manager})
}

// ClearManager removes a Member's Reporting line (admin).
func (s *Service) ClearManager(ctx context.Context, c *auth.Caller, ref string, idem Idem) error {
	if err := mustAdmin(c); err != nil {
		return err
	}
	_, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		id, err := resolveMember(ctx, t, c.OrgID, ref)
		if err != nil {
			return nil, err
		}
		res, err := t.Exec(ctx, `DELETE FROM reporting_lines WHERE org_id = $1 AND member_id = $2`, c.OrgID, id)
		if err != nil {
			return nil, err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return nil, nil
		}
		return nil, t.recordByCaller("member.manager_cleared", id, nil)
	})
	return err
}

// GrantSkill gives a Member a Skill (admin).
func (s *Service) GrantSkill(ctx context.Context, c *auth.Caller, memberRef, skillRef string, idem Idem) error {
	if err := mustAdmin(c); err != nil {
		return err
	}
	_, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		member, err := resolveMember(ctx, t, c.OrgID, memberRef)
		if err != nil {
			return nil, err
		}
		skill, err := resolveSkill(ctx, t, c.OrgID, skillRef)
		if err != nil {
			return nil, err
		}
		return nil, grantSkill(t, member, skill)
	})
	return err
}

// grantSkill gives a Member a Skill inside a write, recording member.skill_granted; a Skill the
// Member has changes nothing.
func grantSkill(t *tx, member, skill string) error {
	var n int
	if err := t.QueryRow(t.ctx, `SELECT COUNT(*) FROM member_skills WHERE org_id = $1 AND member_id = $2 AND skill_id = $3`,
		t.caller.OrgID, member, skill).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	if _, err := t.Exec(t.ctx, `INSERT INTO member_skills (org_id, member_id, skill_id, granted_by, granted_at) VALUES ($1, $2, $3, $4, $5)`,
		t.caller.OrgID, member, skill, t.caller.MemberID, ms(t.now)); err != nil {
		return err
	}
	return t.recordByCaller("member.skill_granted", member, map[string]any{"skill_id": skill})
}

// RevokeSkill takes a Skill away from a Member (admin). Claims held under it are not ended.
func (s *Service) RevokeSkill(ctx context.Context, c *auth.Caller, memberRef, skillRef string, idem Idem) error {
	if err := mustAdmin(c); err != nil {
		return err
	}
	_, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		member, err := resolveMember(ctx, t, c.OrgID, memberRef)
		if err != nil {
			return nil, err
		}
		skill, err := resolveSkill(ctx, t, c.OrgID, skillRef)
		if err != nil {
			return nil, err
		}
		res, err := t.Exec(ctx, `DELETE FROM member_skills WHERE org_id = $1 AND member_id = $2 AND skill_id = $3`, c.OrgID, member, skill)
		if err != nil {
			return nil, err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return nil, nil
		}
		return nil, t.recordByCaller("member.skill_revoked", member, map[string]any{"skill_id": skill})
	})
	return err
}

// otherActiveAdmins counts the active admins other than except into n.
func otherActiveAdmins(t *tx, except string, n *int) error {
	return t.QueryRow(t.ctx, `SELECT COUNT(*) FROM members WHERE org_id = $1 AND admin = TRUE AND deactivated_at IS NULL AND id <> $2`,
		t.caller.OrgID, except).Scan(n)
}

// mustBeActive refuses to issue a credential for a deactivated Member.
func mustBeActive(t *tx, memberID string) error {
	m, err := getMember(t.ctx, t, t.caller.OrgID, memberID)
	if err != nil {
		return err
	}
	if m.DeactivatedAt != nil {
		return refuse(CodeConflict, "%s is deactivated; an admin reactivates them first", m.Name)
	}
	return nil
}

// DeactivateMember stops every credential of a Member at once (admin): it revokes their tokens,
// expires their unused login links, closes their Sessions and ends every Claim they hold, bound to
// a Session or to the Member, recording each in Activity; from then on authentication refuses
// them, and no token or link is issued for them, emailed ones included. The Member stays in the
// record. An admin cannot deactivate themselves, nor the last active admin.
func (s *Service) DeactivateMember(ctx context.Context, c *auth.Caller, ref string, idem Idem) (Member, error) {
	if err := mustAdmin(c); err != nil {
		return Member{}, err
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		id, err := resolveMember(ctx, t, c.OrgID, ref)
		if err != nil {
			return nil, err
		}
		m, err := getMember(ctx, t, c.OrgID, id)
		if err != nil || m.DeactivatedAt != nil {
			return m, err
		}
		if id == c.MemberID {
			return nil, refuse(CodeForbidden, "you cannot deactivate yourself; another admin can")
		}
		if m.Admin {
			var n int
			if err := otherActiveAdmins(t, id, &n); err != nil {
				return nil, err
			}
			if n == 0 {
				return nil, refuse(CodeConflict, "%s is the last active admin", m.Name)
			}
		}
		if _, err := t.Exec(ctx, `UPDATE members SET deactivated_at = $1, updated_at = $1 WHERE org_id = $2 AND id = $3`, ms(t.now), c.OrgID, id); err != nil {
			return nil, err
		}
		if err := t.recordByCaller("member.deactivated", id, nil); err != nil {
			return nil, err
		}
		tokens, err := collect(ctx, t, func(row interface{ Scan(...any) error }) (string, error) {
			var tok string
			return tok, row.Scan(&tok)
		}, `SELECT id FROM tokens WHERE org_id = $1 AND member_id = $2 AND revoked_at IS NULL ORDER BY id`, c.OrgID, id)
		if err != nil {
			return nil, err
		}
		for _, tok := range tokens {
			if _, err := t.Exec(ctx, `UPDATE tokens SET revoked_at = $1 WHERE org_id = $2 AND id = $3`, ms(t.now), c.OrgID, tok); err != nil {
				return nil, err
			}
			if err := t.recordByCaller("token.revoked", tok, map[string]any{"member_id": id}); err != nil {
				return nil, err
			}
		}
		// A link issued before must not sign them in after a reactivation either.
		if _, err := t.Exec(ctx, `UPDATE login_links SET expires_at = $1 WHERE org_id = $2 AND member_id = $3 AND used_at IS NULL AND expires_at > $1`,
			ms(t.now), c.OrgID, id); err != nil {
			return nil, err
		}
		sessions, err := openSessions(t, `member_id = $2`, id)
		if err != nil {
			return nil, err
		}
		for _, sess := range sessions {
			if _, err := closeSession(t, sess, "member_deactivated", &c.MemberID); err != nil {
				return nil, err
			}
		}
		// What is left is bound to the Member, which no Session's close ends.
		if _, err := endClaims(t, `t.claim_holder_id = $2`, id, "member_deactivated", &c.MemberID); err != nil {
			return nil, err
		}
		return getMember(ctx, t, c.OrgID, id)
	})
	if err != nil {
		return Member{}, err
	}
	return res.(Member), nil
}

// ReactivateMember lets a deactivated Member sign in and be issued tokens again (admin). It
// revives nothing: the tokens, login links and Sessions the deactivation ended stay ended, so the
// Member needs a new token or link.
func (s *Service) ReactivateMember(ctx context.Context, c *auth.Caller, ref string, idem Idem) (Member, error) {
	if err := mustAdmin(c); err != nil {
		return Member{}, err
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		id, err := resolveMember(ctx, t, c.OrgID, ref)
		if err != nil {
			return nil, err
		}
		m, err := getMember(ctx, t, c.OrgID, id)
		if err != nil || m.DeactivatedAt == nil {
			return m, err
		}
		if _, err := t.Exec(ctx, `UPDATE members SET deactivated_at = NULL, updated_at = $1 WHERE org_id = $2 AND id = $3`, ms(t.now), c.OrgID, id); err != nil {
			return nil, err
		}
		if err := t.recordByCaller("member.reactivated", id, nil); err != nil {
			return nil, err
		}
		return getMember(ctx, t, c.OrgID, id)
	})
	if err != nil {
		return Member{}, err
	}
	return res.(Member), nil
}
