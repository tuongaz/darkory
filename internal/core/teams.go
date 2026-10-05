package core

import (
	"context"
	"regexp"
	"strconv"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/store"
)

func newID() string { return store.NewID() }

func itoa(n int) string { return strconv.Itoa(n) }

var teamKey = regexp.MustCompile(`^[A-Z][A-Z0-9]{1,9}$`)

// CreateTeam creates a Team (admin). Its key prefixes the display keys of its Features and Tasks.
func (s *Service) CreateTeam(ctx context.Context, c *auth.Caller, key, name string, idem Idem) (Team, error) {
	if err := mustAdmin(c); err != nil {
		return Team{}, err
	}
	if !teamKey.MatchString(key) {
		return Team{}, refuse(CodeInvalid, "a Team key is 2 to 10 capital letters or digits, starting with a letter, such as WEB")
	}
	if err := validName("name", name); err != nil {
		return Team{}, err
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		var n int
		if err := t.QueryRow(ctx, `SELECT COUNT(*) FROM teams WHERE org_id = $1 AND (key_prefix = $2 OR name = $3)`,
			c.OrgID, key, name).Scan(&n); err != nil {
			return nil, err
		}
		if n > 0 {
			return nil, refuse(CodeConflict, "a Team already has the key %s or the name %q", key, name)
		}
		id := newID()
		if _, err := t.Exec(ctx, `INSERT INTO teams (id, org_id, key_prefix, name, last_number, created_at) VALUES ($1, $2, $3, $4, 0, $5)`,
			id, c.OrgID, key, name, ms(t.now)); err != nil {
			return nil, err
		}
		if err := t.recordByCaller("team.created", id, map[string]any{"key": key, "name": name}); err != nil {
			return nil, err
		}
		return getTeam(ctx, t, c.OrgID, id)
	})
	if err != nil {
		return Team{}, err
	}
	return res.(Team), nil
}

// ListTeams lists the Teams by name.
func (s *Service) ListTeams(ctx context.Context, c *auth.Caller) ([]Team, error) {
	return collect(ctx, s.store, scanTeam, `SELECT `+teamCols+` FROM teams tm WHERE tm.org_id = $1 ORDER BY tm.name`, c.OrgID)
}

// GetTeam returns a Team and its Members.
func (s *Service) GetTeam(ctx context.Context, c *auth.Caller, ref string) (TeamDetail, error) {
	id, err := resolveTeam(ctx, s.store, c.OrgID, ref)
	if err != nil {
		return TeamDetail{}, err
	}
	return getTeamDetail(ctx, s.store, c.OrgID, id)
}

// AddTeamMember puts a Member in a Team (admin).
func (s *Service) AddTeamMember(ctx context.Context, c *auth.Caller, teamRef, memberRef string, idem Idem) error {
	if err := mustAdmin(c); err != nil {
		return err
	}
	_, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		team, err := resolveTeam(ctx, t, c.OrgID, teamRef)
		if err != nil {
			return nil, err
		}
		member, err := resolveMember(ctx, t, c.OrgID, memberRef)
		if err != nil {
			return nil, err
		}
		if in, err := inTeam(ctx, t, c.OrgID, team, member); err != nil || in {
			return nil, err
		}
		if _, err := t.Exec(ctx, `INSERT INTO team_members (org_id, team_id, member_id, added_at) VALUES ($1, $2, $3, $4)`,
			c.OrgID, team, member, ms(t.now)); err != nil {
			return nil, err
		}
		return nil, t.recordByCaller("team.member_added", team, map[string]any{"member_id": member})
	})
	return err
}

// RemoveTeamMember takes a Member out of a Team (admin). Their Claims on its Tasks are not ended.
func (s *Service) RemoveTeamMember(ctx context.Context, c *auth.Caller, teamRef, memberRef string, idem Idem) error {
	if err := mustAdmin(c); err != nil {
		return err
	}
	_, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		team, err := resolveTeam(ctx, t, c.OrgID, teamRef)
		if err != nil {
			return nil, err
		}
		member, err := resolveMember(ctx, t, c.OrgID, memberRef)
		if err != nil {
			return nil, err
		}
		res, err := t.Exec(ctx, `DELETE FROM team_members WHERE org_id = $1 AND team_id = $2 AND member_id = $3`, c.OrgID, team, member)
		if err != nil {
			return nil, err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return nil, nil
		}
		return nil, t.recordByCaller("team.member_removed", team, map[string]any{"member_id": member})
	})
	return err
}
