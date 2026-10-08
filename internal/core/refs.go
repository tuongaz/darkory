package core

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/tuongaz/darkory/internal/shortid"
	"github.com/tuongaz/darkory/internal/store"
)

// References name a record by id or by its natural key: a Member's name, a Project's key, a
// Skill's name, a Task's display key (decisions.md), a Step's name within its Project. Each
// resolver returns the id. An id is read in either form, short or canonical (ADR 0017): $2 is the
// reference as given, for the natural key, and $3 its canonical text, for the id.

type storeReader = store.Reader

func resolve(ctx context.Context, r store.Reader, what, query, orgID, ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return "", refuse(CodeInvalid, "a %s reference is empty", what)
	}
	args := []any{orgID, ref}
	if strings.Contains(query, "$3") {
		args = append(args, shortid.Canonical(ref))
	}
	var id string
	err := r.QueryRow(ctx, query, args...).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", refuse(CodeNotFound, "no %s %q", what, ref)
	}
	if err != nil {
		return "", fmt.Errorf("core: resolve %s: %w", what, err)
	}
	return id, nil
}

func resolveMember(ctx context.Context, r store.Reader, orgID, ref string) (string, error) {
	return resolve(ctx, r, "Member", `SELECT id FROM members WHERE org_id = $1 AND (id = $3 OR name = $2)`, orgID, ref)
}

func resolveProject(ctx context.Context, r store.Reader, orgID, ref string) (string, error) {
	return resolve(ctx, r, "Project", `SELECT id FROM projects WHERE org_id = $1 AND (id = $3 OR key_prefix = $2)`, orgID, ref)
}

func resolveSkill(ctx context.Context, r store.Reader, orgID, ref string) (string, error) {
	return resolve(ctx, r, "Skill", `SELECT id FROM skills WHERE org_id = $1 AND (id = $3 OR name = $2)`, orgID, ref)
}

// resolveTask resolves a Task by its id or display key; a Parent is a Task like any other.
func resolveTask(ctx context.Context, r store.Reader, orgID, ref string) (string, error) {
	return resolve(ctx, r, "Task", `SELECT id FROM tasks WHERE org_id = $1 AND (id = $3 OR display_key = $2)`, orgID, ref)
}

// skillByName finds a built-in Skill, which Darkory relies on existing.
func skillByName(ctx context.Context, r store.Reader, orgID, name string) (string, error) {
	return resolve(ctx, r, "Skill", `SELECT id FROM skills WHERE org_id = $1 AND name = $2`, orgID, name)
}

func inProject(ctx context.Context, r store.Reader, orgID, projectID, memberID string) (bool, error) {
	var n int
	err := r.QueryRow(ctx, `SELECT COUNT(*) FROM project_members WHERE org_id = $1 AND project_id = $2 AND member_id = $3`,
		orgID, projectID, memberID).Scan(&n)
	return n > 0, err
}
