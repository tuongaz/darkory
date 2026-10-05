package core

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/tuongaz/darkory/internal/store"
)

// References name a record by id or by its natural key: a Member's name, a Team's key, a Skill's
// name, a Feature's or Task's display key (decisions.md). Each resolver returns the id.

type storeReader = store.Reader

func resolve(ctx context.Context, r store.Reader, what, query, orgID, ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return "", refuse(CodeInvalid, "a %s reference is empty", what)
	}
	var id string
	err := r.QueryRow(ctx, query, orgID, ref).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", refuse(CodeNotFound, "no %s %q", what, ref)
	}
	if err != nil {
		return "", fmt.Errorf("core: resolve %s: %w", what, err)
	}
	return id, nil
}

func resolveMember(ctx context.Context, r store.Reader, orgID, ref string) (string, error) {
	return resolve(ctx, r, "Member", `SELECT id FROM members WHERE org_id = $1 AND (id = $2 OR name = $2)`, orgID, ref)
}

func resolveTeam(ctx context.Context, r store.Reader, orgID, ref string) (string, error) {
	return resolve(ctx, r, "Team", `SELECT id FROM teams WHERE org_id = $1 AND (id = $2 OR key_prefix = $2)`, orgID, ref)
}

func resolveSkill(ctx context.Context, r store.Reader, orgID, ref string) (string, error) {
	return resolve(ctx, r, "Skill", `SELECT id FROM skills WHERE org_id = $1 AND (id = $2 OR name = $2)`, orgID, ref)
}

func resolveFeature(ctx context.Context, r store.Reader, orgID, ref string) (string, error) {
	return resolve(ctx, r, "Feature", `SELECT id FROM features WHERE org_id = $1 AND (id = $2 OR display_key = $2)`, orgID, ref)
}

func resolveTask(ctx context.Context, r store.Reader, orgID, ref string) (string, error) {
	return resolve(ctx, r, "Task", `SELECT id FROM tasks WHERE org_id = $1 AND (id = $2 OR display_key = $2)`, orgID, ref)
}

// skillByName finds a built-in Skill, which Darkory relies on existing.
func skillByName(ctx context.Context, r store.Reader, orgID, name string) (string, error) {
	return resolve(ctx, r, "Skill", `SELECT id FROM skills WHERE org_id = $1 AND name = $2`, orgID, name)
}

func inTeam(ctx context.Context, r store.Reader, orgID, teamID, memberID string) (bool, error) {
	var n int
	err := r.QueryRow(ctx, `SELECT COUNT(*) FROM team_members WHERE org_id = $1 AND team_id = $2 AND member_id = $3`,
		orgID, teamID, memberID).Scan(&n)
	return n > 0, err
}
