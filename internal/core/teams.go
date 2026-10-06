package core

import (
	"context"
	"regexp"
	"strconv"
	"strings"

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
		id, err := createTeam(t, key, name)
		if err != nil {
			return nil, err
		}
		return getTeam(ctx, t, c.OrgID, id)
	})
	if err != nil {
		return Team{}, err
	}
	return res.(Team), nil
}

// createTeam creates a Team inside a write and records team.created.
func createTeam(t *tx, key, name string) (string, error) {
	var n int
	if err := t.QueryRow(t.ctx, `SELECT COUNT(*) FROM teams WHERE org_id = $1 AND (key_prefix = $2 OR name = $3)`,
		t.caller.OrgID, key, name).Scan(&n); err != nil {
		return "", err
	}
	if n > 0 {
		return "", refuse(CodeConflict, "a Team already has the key %s or the name %q", key, name)
	}
	id := newID()
	if _, err := t.Exec(t.ctx, `INSERT INTO teams (id, org_id, key_prefix, name, last_number, created_at) VALUES ($1, $2, $3, $4, 0, $5)`,
		id, t.caller.OrgID, key, name, ms(t.now)); err != nil {
		return "", err
	}
	return id, t.recordByCaller("team.created", id, map[string]any{"key": key, "name": name})
}

// TeamChange is what UpdateTeam changes; nil fields stay as they are. DefaultWorkspace names a
// Workspace by id or name, or "" for none.
type TeamChange struct {
	Name             *string
	DefaultWorkspace *string
	ShipWhenDone     *bool
}

// UpdateTeam changes a Team's name, default Workspace or Ship-when-done default (admin).
func (s *Service) UpdateTeam(ctx context.Context, c *auth.Caller, ref string, ch TeamChange, idem Idem) (Team, error) {
	if err := mustAdmin(c); err != nil {
		return Team{}, err
	}
	if ch.Name != nil {
		if err := validName("name", *ch.Name); err != nil {
			return Team{}, err
		}
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		id, err := resolveTeam(ctx, t, c.OrgID, ref)
		if err != nil {
			return nil, err
		}
		tm, err := getTeam(ctx, t, c.OrgID, id)
		if err != nil {
			return nil, err
		}
		payload := map[string]any{}
		if ch.Name != nil && *ch.Name != tm.Name {
			var n int
			if err := t.QueryRow(ctx, `SELECT COUNT(*) FROM teams WHERE org_id = $1 AND name = $2 AND id <> $3`, c.OrgID, *ch.Name, id).Scan(&n); err != nil {
				return nil, err
			}
			if n > 0 {
				return nil, refuse(CodeConflict, "a Team is already named %q", *ch.Name)
			}
			tm.Name, payload["name"] = *ch.Name, *ch.Name
		}
		if ch.DefaultWorkspace != nil {
			var ws *string
			if strings.TrimSpace(*ch.DefaultWorkspace) != "" {
				wid, err := resolveWorkspace(ctx, t, c.OrgID, *ch.DefaultWorkspace)
				if err != nil {
					return nil, err
				}
				ws = &wid
			}
			if !sameRef(ws, tm.DefaultWorkspaceID) {
				tm.DefaultWorkspaceID, payload["default_workspace_id"] = ws, ws
			}
		}
		if ch.ShipWhenDone != nil && *ch.ShipWhenDone != tm.ShipWhenDone {
			tm.ShipWhenDone, payload["ship_when_done"] = *ch.ShipWhenDone, *ch.ShipWhenDone
		}
		if len(payload) == 0 {
			return tm, nil
		}
		if _, err := t.Exec(ctx, `UPDATE teams SET name = $1, default_workspace_id = $2, ship_when_done = $3 WHERE org_id = $4 AND id = $5`,
			tm.Name, tm.DefaultWorkspaceID, tm.ShipWhenDone, c.OrgID, id); err != nil {
			return nil, err
		}
		if err := t.recordByCaller("team.changed", id, payload); err != nil {
			return nil, err
		}
		return tm, nil
	})
	if err != nil {
		return Team{}, err
	}
	return res.(Team), nil
}

// sameRef reports whether two optional ids name the same record, or both none.
func sameRef(a, b *string) bool {
	return (a == nil) == (b == nil) && (a == nil || *a == *b)
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
		return nil, addTeamMember(t, team, member)
	})
	return err
}

// addTeamMember puts a Member in a Team inside a write, recording team.member_added; a Member
// already in it changes nothing.
func addTeamMember(t *tx, team, member string) error {
	if in, err := inTeam(t.ctx, t, t.caller.OrgID, team, member); err != nil || in {
		return err
	}
	if _, err := t.Exec(t.ctx, `INSERT INTO team_members (org_id, team_id, member_id, added_at) VALUES ($1, $2, $3, $4)`,
		t.caller.OrgID, team, member, ms(t.now)); err != nil {
		return err
	}
	return t.recordByCaller("team.member_added", team, map[string]any{"member_id": member})
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
