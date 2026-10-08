package core

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/shortid"
	"github.com/tuongaz/darkory/internal/store"
)

// Workspaces are the places sessions work in, named on the Install (ADR 0013). A Project has a
// default, and a Task names one or more; a Task filed naming none takes its Project's default, or
// names none when the Project has none (decisions.md).

var workspaceName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`)

// branchName is what a default branch may be called: a git branch name without the characters
// and sequences git refuses, nor any that a shell or a path would read specially.
var branchName = regexp.MustCompile(`^[A-Za-z0-9._][A-Za-z0-9._/-]{0,254}$`)

// DefaultBranch is a Workspace's default branch when none is given.
const DefaultBranch = "main"

// NewWorkspace is a Workspace to add. Kind defaults to git, Mode to plain and DefaultBranch to
// main.
type NewWorkspace struct {
	Name          string
	Kind          string
	Path          string
	Mode          string
	DefaultBranch string
}

// WorkspaceChange is what UpdateWorkspace changes; nil fields stay as they are.
type WorkspaceChange struct {
	Name, Path, Mode, DefaultBranch *string
}

func validWorkspaceName(name string) error {
	if !workspaceName.MatchString(name) || looksLikeID(name) {
		return refuse(CodeInvalid, "a Workspace name is 1 to 63 letters, digits, dots, dashes and underscores, starting with a letter or digit, such as web")
	}
	return nil
}

func validWorkspacePath(path string) (string, error) {
	if strings.ContainsRune(path, 0) || len(path) > 4096 || !filepath.IsAbs(path) {
		return "", refuse(CodeInvalid, "a Workspace's path is the repository's absolute path, such as /home/ada/src/web")
	}
	return filepath.Clean(path), nil
}

func validMode(mode string) error {
	if mode != "plain" && mode != "pull_request" {
		return refuse(CodeInvalid, "a Workspace's mode is plain or pull_request")
	}
	return nil
}

func validBranch(branch string) error {
	if !branchName.MatchString(branch) || strings.Contains(branch, "..") || strings.Contains(branch, "//") ||
		strings.HasSuffix(branch, "/") || strings.HasSuffix(branch, ".") || strings.HasSuffix(branch, ".lock") {
		return refuse(CodeInvalid, "%q is not a branch name git takes", branch)
	}
	return nil
}

// workspaceNameFree refuses a name another Workspace (not except) has, ignoring case; names are
// ASCII, so lower() is the same on both engines.
func workspaceNameFree(t *tx, except, name string) error {
	var n int
	if err := t.QueryRow(t.ctx, `SELECT COUNT(*) FROM workspaces WHERE org_id = $1 AND lower(name) = lower($2) AND id <> $3`,
		t.caller.OrgID, name, except).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return refuse(CodeConflict, "a Workspace is already named %q", name)
	}
	return nil
}

// CreateWorkspace adds a Workspace to the Install (admin).
func (s *Service) CreateWorkspace(ctx context.Context, c *auth.Caller, nw NewWorkspace, idem Idem) (Workspace, error) {
	if err := mustAdmin(c); err != nil {
		return Workspace{}, err
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		id, err := createWorkspace(t, nw)
		if err != nil {
			return nil, err
		}
		return getWorkspace(ctx, t, c.OrgID, id)
	})
	if err != nil {
		return Workspace{}, err
	}
	return res.(Workspace), nil
}

// createWorkspace adds a Workspace inside a write and records workspace.added.
func createWorkspace(t *tx, nw NewWorkspace) (string, error) {
	if nw.Kind == "" {
		nw.Kind = "git"
	}
	if nw.Mode == "" {
		nw.Mode = "plain"
	}
	if nw.DefaultBranch == "" {
		nw.DefaultBranch = DefaultBranch
	}
	if err := validWorkspaceName(nw.Name); err != nil {
		return "", err
	}
	if nw.Kind != "git" {
		return "", refuse(CodeInvalid, "a Workspace's kind is git")
	}
	path, err := validWorkspacePath(nw.Path)
	if err != nil {
		return "", err
	}
	if err := validMode(nw.Mode); err != nil {
		return "", err
	}
	if err := validBranch(nw.DefaultBranch); err != nil {
		return "", err
	}
	if err := workspaceNameFree(t, "", nw.Name); err != nil {
		return "", err
	}
	id := newID()
	if _, err := t.Exec(t.ctx, `INSERT INTO workspaces (id, org_id, name, kind, path, mode, default_branch, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, id, t.caller.OrgID, nw.Name, nw.Kind, path, nw.Mode, nw.DefaultBranch, ms(t.now)); err != nil {
		return "", err
	}
	return id, t.recordByCaller("workspace.added", id, map[string]any{"name": nw.Name, "kind": nw.Kind, "path": path,
		"mode": nw.Mode, "default_branch": nw.DefaultBranch})
}

// ListWorkspaces lists the Install's Workspaces by name.
func (s *Service) ListWorkspaces(ctx context.Context, c *auth.Caller) ([]Workspace, error) {
	return collect(ctx, s.store, scanWorkspace, `SELECT `+workspaceCols+` FROM workspaces w WHERE w.org_id = $1 ORDER BY lower(w.name)`, c.OrgID)
}

// UpdateWorkspace changes a Workspace's name, path, mode or default branch (admin).
func (s *Service) UpdateWorkspace(ctx context.Context, c *auth.Caller, ref string, ch WorkspaceChange, idem Idem) (Workspace, error) {
	if err := mustAdmin(c); err != nil {
		return Workspace{}, err
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		id, err := resolveWorkspace(ctx, t, c.OrgID, ref)
		if err != nil {
			return nil, err
		}
		w, err := getWorkspace(ctx, t, c.OrgID, id)
		if err != nil {
			return nil, err
		}
		payload := map[string]any{}
		next := w
		if ch.Name != nil && *ch.Name != w.Name {
			if err := validWorkspaceName(*ch.Name); err != nil {
				return nil, err
			}
			if err := workspaceNameFree(t, id, *ch.Name); err != nil {
				return nil, err
			}
			next.Name, payload["name"] = *ch.Name, *ch.Name
		}
		if ch.Path != nil {
			path, err := validWorkspacePath(*ch.Path)
			if err != nil {
				return nil, err
			}
			if path != w.Path {
				next.Path, payload["path"] = path, path
			}
		}
		if ch.Mode != nil && *ch.Mode != w.Mode {
			if err := validMode(*ch.Mode); err != nil {
				return nil, err
			}
			next.Mode, payload["mode"] = *ch.Mode, *ch.Mode
		}
		if ch.DefaultBranch != nil && *ch.DefaultBranch != w.DefaultBranch {
			if err := validBranch(*ch.DefaultBranch); err != nil {
				return nil, err
			}
			next.DefaultBranch, payload["default_branch"] = *ch.DefaultBranch, *ch.DefaultBranch
		}
		if len(payload) == 0 {
			return w, nil
		}
		if _, err := t.Exec(ctx, `UPDATE workspaces SET name = $1, path = $2, mode = $3, default_branch = $4 WHERE org_id = $5 AND id = $6`,
			next.Name, next.Path, next.Mode, next.DefaultBranch, c.OrgID, id); err != nil {
			return nil, err
		}
		if err := t.recordByCaller("workspace.changed", id, payload); err != nil {
			return nil, err
		}
		return next, nil
	})
	if err != nil {
		return Workspace{}, err
	}
	return res.(Workspace), nil
}

// RemoveWorkspace removes a Workspace no Task names, open or ended (admin). A Project whose
// default it was has none afterwards, recorded as project.changed.
func (s *Service) RemoveWorkspace(ctx context.Context, c *auth.Caller, ref string, idem Idem) error {
	if err := mustAdmin(c); err != nil {
		return err
	}
	_, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		id, err := resolveWorkspace(ctx, t, c.OrgID, ref)
		if err != nil {
			return nil, err
		}
		w, err := getWorkspace(ctx, t, c.OrgID, id)
		if err != nil {
			return nil, err
		}
		var n int
		if err := t.QueryRow(ctx, `SELECT COUNT(*) FROM task_workspaces WHERE org_id = $1 AND workspace_id = $2`, c.OrgID, id).Scan(&n); err != nil {
			return nil, err
		}
		switch {
		case n == 1:
			return nil, refuse(CodeConflict, "1 Task names Workspace %s; the record keeps where its work was done", w.Name)
		case n > 1:
			return nil, refuse(CodeConflict, "%d Tasks name Workspace %s; the record keeps where their work was done", n, w.Name)
		}
		projects, err := collect(ctx, t, func(row interface{ Scan(...any) error }) (string, error) {
			var project string
			return project, row.Scan(&project)
		}, `SELECT id FROM projects WHERE org_id = $1 AND default_workspace_id = $2 ORDER BY id`, c.OrgID, id)
		if err != nil {
			return nil, err
		}
		if _, err := t.Exec(ctx, `UPDATE projects SET default_workspace_id = NULL WHERE org_id = $1 AND default_workspace_id = $2`, c.OrgID, id); err != nil {
			return nil, err
		}
		if _, err := t.Exec(ctx, `DELETE FROM workspaces WHERE org_id = $1 AND id = $2`, c.OrgID, id); err != nil {
			return nil, err
		}
		if err := t.recordByCaller("workspace.removed", id, map[string]any{"name": w.Name}); err != nil {
			return nil, err
		}
		for _, project := range projects {
			if err := t.recordByCaller("project.changed", project, map[string]any{"default_workspace_id": nil}); err != nil {
				return nil, err
			}
		}
		return nil, nil
	})
	return err
}

func getWorkspace(ctx context.Context, r store.Reader, orgID, id string) (Workspace, error) {
	id = shortid.Canonical(id) // either form (ADR 0017)
	w, err := scanWorkspace(r.QueryRow(ctx, `SELECT `+workspaceCols+` FROM workspaces w WHERE w.org_id = $1 AND w.id = $2`, orgID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return w, refuse(CodeNotFound, "no Workspace %s", id)
	}
	return w, err
}

// resolveWorkspace finds a Workspace by id, or by name ignoring case.
func resolveWorkspace(ctx context.Context, r store.Reader, orgID, ref string) (string, error) {
	return resolve(ctx, r, "Workspace", `SELECT id FROM workspaces WHERE org_id = $1 AND (id = $3 OR lower(name) = lower($2))`, orgID, ref)
}

// taskWorkspaces resolves the Workspaces a Task to be filed in projectID names: refs when given,
// in their order and each once, an empty list naming none; else the Project's default, or none.
func taskWorkspaces(t *tx, projectID string, refs *[]string) ([]string, error) {
	if refs == nil {
		var def sql.NullString
		if err := t.QueryRow(t.ctx, `SELECT default_workspace_id FROM projects WHERE org_id = $1 AND id = $2`, t.caller.OrgID, projectID).Scan(&def); err != nil {
			return nil, err
		}
		if !def.Valid {
			return nil, nil
		}
		return []string{def.String}, nil
	}
	var ids []string
	for _, ref := range *refs {
		id, err := resolveWorkspace(t.ctx, t, t.caller.OrgID, ref)
		if err != nil {
			return nil, err
		}
		if !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
	}
	return ids, nil
}

// nameWorkspaces records the Workspaces a Task names, in order.
func nameWorkspaces(t *tx, taskID string, ids []string) error {
	for i, id := range ids {
		if _, err := t.Exec(t.ctx, `INSERT INTO task_workspaces (org_id, task_id, workspace_id, position) VALUES ($1, $2, $3, $4)`,
			t.caller.OrgID, taskID, id, i+1); err != nil {
			return err
		}
	}
	return nil
}
