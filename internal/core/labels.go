package core

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/shortid"
	"github.com/tuongaz/darkory/internal/store"
)

// Labels: named, coloured marks a Project defines for itself or the Organisation for every
// Project. Filters and Views read them; Darkory's rules never do.

const labelCols = `l.id, l.project_id, l.name, l.color, l.created_at`

func scanLabel(row interface{ Scan(...any) error }) (Label, error) {
	var l Label
	var project sql.NullString
	var created int64
	err := row.Scan(&l.ID, &project, &l.Name, &l.Color, &created)
	l.ProjectID, l.CreatedAt = nullString(project), fromMS(created)
	return l, err
}

func getLabel(ctx context.Context, r store.Reader, orgID, id string) (Label, error) {
	id = shortid.Canonical(id) // either form (ADR 0017)
	l, err := scanLabel(r.QueryRow(ctx, `SELECT `+labelCols+` FROM labels l WHERE l.org_id = $1 AND l.id = $2`, orgID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return l, refuse(CodeNotFound, "no Label %s", id)
	}
	return l, err
}

var labelColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func validLabel(name, color *string) error {
	if name != nil {
		n := strings.TrimSpace(*name)
		if n == "" || utf8.RuneCountInString(n) > 50 || strings.ContainsFunc(n, unicode.IsControl) {
			return refuse(CodeInvalid, "a Label's name is 1 to 50 characters, on one line")
		}
		if looksLikeID(n) {
			return refuse(CodeInvalid, "a Label's name cannot be spelled as an id")
		}
	}
	if color != nil && !labelColor.MatchString(*color) {
		return refuse(CodeInvalid, "a Label's color is #rrggbb, not %q", *color)
	}
	return nil
}

// mayLabel refuses a caller who may not define Labels where project says: the Organisation's
// (project nil) are an admin's; a Project's, any of its Members' or an admin's.
func mayLabel(ctx context.Context, r store.Reader, c *auth.Caller, project *string) error {
	if c.Admin {
		return nil
	}
	if project == nil {
		return refuse(CodeForbidden, "only an admin may define the Organisation's Labels")
	}
	in, err := inProject(ctx, r, c.OrgID, *project, c.MemberID)
	if err != nil {
		return err
	}
	if !in {
		return refuse(CodeForbidden, "only a Member of the Project or an admin may define its Labels")
	}
	return nil
}

// labelNameFree refuses a name another Label (not except) has where it would mean two Labels,
// ignoring case: a Project's Label shares no name with the Project's other Labels or the
// Organisation's, and an Organisation's Label none with any Label at all, so that a name always
// names one Label. It compares in Go, since lower() differs between the engines.
func labelNameFree(t *tx, except string, project *string, name string) error {
	q, args := `SELECT `+labelCols+` FROM labels l WHERE l.org_id = $1`, []any{t.caller.OrgID}
	if project != nil {
		q, args = q+` AND (l.project_id IS NULL OR l.project_id = $2)`, append(args, *project)
	}
	taken, err := collect(t.ctx, t, scanLabel, q, args...)
	if err != nil {
		return err
	}
	for _, l := range taken {
		if l.ID == except || !strings.EqualFold(l.Name, name) {
			continue
		}
		if l.ProjectID == nil {
			return refuse(CodeConflict, "the Organisation has a Label named %q", l.Name)
		}
		if project == nil {
			return refuse(CodeConflict, "a Project has a Label named %q; an Organisation's Label shares no name with a Project's", l.Name)
		}
		return refuse(CodeConflict, "the Project has a Label named %q", l.Name)
	}
	return nil
}

// NewLabel is a Label to define: Project names the Project it is for, nil for the
// Organisation's.
type NewLabel struct {
	Project *string
	Name    string
	Color   string
}

// CreateLabel defines a Label: the Organisation's by an admin, a Project's by any of its Members.
func (s *Service) CreateLabel(ctx context.Context, c *auth.Caller, nl NewLabel, idem Idem) (Label, error) {
	if err := validLabel(&nl.Name, &nl.Color); err != nil {
		return Label{}, err
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		var project *string
		if nl.Project != nil {
			id, err := resolveProject(ctx, t, c.OrgID, *nl.Project)
			if err != nil {
				return nil, err
			}
			project = &id
		}
		if err := mayLabel(ctx, t, c, project); err != nil {
			return nil, err
		}
		name := strings.TrimSpace(nl.Name)
		if err := labelNameFree(t, "", project, name); err != nil {
			return nil, err
		}
		id := newID()
		color := strings.ToLower(nl.Color)
		if _, err := t.Exec(ctx, `INSERT INTO labels (id, org_id, project_id, name, color, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
			id, c.OrgID, project, name, color, ms(t.now)); err != nil {
			return nil, err
		}
		payload := map[string]any{"name": name, "color": color}
		if project != nil {
			payload["project_id"] = *project
		}
		if err := t.recordByCaller("label.created", id, payload); err != nil {
			return nil, err
		}
		return getLabel(ctx, t, c.OrgID, id)
	})
	if err != nil {
		return Label{}, err
	}
	return res.(Label), nil
}

// ListLabels lists a Project's own Labels, or the Organisation's when project is nil, by name.
func (s *Service) ListLabels(ctx context.Context, c *auth.Caller, project *string) ([]Label, error) {
	if project == nil {
		return collect(ctx, s.store, scanLabel, `SELECT `+labelCols+` FROM labels l WHERE l.org_id = $1 AND l.project_id IS NULL
ORDER BY l.name, l.id`, c.OrgID)
	}
	id, err := resolveProject(ctx, s.store, c.OrgID, *project)
	if err != nil {
		return nil, err
	}
	return collect(ctx, s.store, scanLabel, `SELECT `+labelCols+` FROM labels l WHERE l.org_id = $1 AND l.project_id = $2
ORDER BY l.name, l.id`, c.OrgID, id)
}

// LabelChange is what UpdateLabel changes; nil fields stay as they are.
type LabelChange struct {
	Name  *string
	Color *string
}

// UpdateLabel renames or recolours a Label, with the authority that defines it.
func (s *Service) UpdateLabel(ctx context.Context, c *auth.Caller, id string, ch LabelChange, idem Idem) (Label, error) {
	if err := validLabel(ch.Name, ch.Color); err != nil {
		return Label{}, err
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		l, err := getLabel(ctx, t, c.OrgID, id)
		if err != nil {
			return nil, err
		}
		if err := mayLabel(ctx, t, c, l.ProjectID); err != nil {
			return nil, err
		}
		payload := map[string]any{}
		if ch.Name != nil && strings.TrimSpace(*ch.Name) != l.Name {
			name := strings.TrimSpace(*ch.Name)
			if err := labelNameFree(t, l.ID, l.ProjectID, name); err != nil {
				return nil, err
			}
			l.Name, payload["name"] = name, name
		}
		if ch.Color != nil && strings.ToLower(*ch.Color) != l.Color {
			l.Color, payload["color"] = strings.ToLower(*ch.Color), strings.ToLower(*ch.Color)
		}
		if len(payload) == 0 {
			return l, nil
		}
		if _, err := t.Exec(ctx, `UPDATE labels SET name = $1, color = $2 WHERE org_id = $3 AND id = $4`, l.Name, l.Color, c.OrgID, l.ID); err != nil {
			return nil, err
		}
		if l.ProjectID != nil {
			payload["project_id"] = *l.ProjectID
		}
		return l, t.recordByCaller("label.changed", l.ID, payload)
	})
	if err != nil {
		return Label{}, err
	}
	return res.(Label), nil
}

// DeleteLabel deletes a Label, with the authority that defines it; the Tasks carrying it stop.
func (s *Service) DeleteLabel(ctx context.Context, c *auth.Caller, id string, idem Idem) error {
	_, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		l, err := getLabel(ctx, t, c.OrgID, id)
		if err != nil {
			return nil, err
		}
		if err := mayLabel(ctx, t, c, l.ProjectID); err != nil {
			return nil, err
		}
		res, err := t.Exec(ctx, `DELETE FROM task_labels WHERE org_id = $1 AND label_id = $2`, c.OrgID, l.ID)
		if err != nil {
			return nil, err
		}
		n, _ := res.RowsAffected()
		if _, err := t.Exec(ctx, `DELETE FROM labels WHERE org_id = $1 AND id = $2`, c.OrgID, l.ID); err != nil {
			return nil, err
		}
		payload := map[string]any{"name": l.Name, "tasks": n}
		if l.ProjectID != nil {
			payload["project_id"] = *l.ProjectID
		}
		return nil, t.recordByCaller("label.deleted", l.ID, payload)
	})
	return err
}

// SetTaskLabels sets the Labels a Task carries to labels, each the Task's Project's or the
// Organisation's: by any Member of the Project or its Owner, whoever holds it, since Darkory's
// rules never read a Label.
func (s *Service) SetTaskLabels(ctx context.Context, c *auth.Caller, ref string, labels []string, idem Idem) (Task, error) {
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		taskID, err := resolveTask(ctx, t, c.OrgID, ref)
		if err != nil {
			return nil, err
		}
		task, err := getTask(ctx, t, c.OrgID, taskID, t.now)
		if err != nil {
			return nil, err
		}
		if err := inProjectOrOwner(ctx, t, c, task, "set the Labels of"); err != nil {
			return nil, err
		}
		want, err := taskLabels(t, task.ProjectID, labels)
		if err != nil {
			return nil, err
		}
		var added, removed []string
		for _, id := range want {
			if !slices.Contains(task.Labels, id) {
				added = append(added, id)
			}
		}
		for _, id := range task.Labels {
			if !slices.Contains(want, id) {
				removed = append(removed, id)
			}
		}
		if len(added) == 0 && len(removed) == 0 {
			return task, nil
		}
		for _, id := range removed {
			if _, err := t.Exec(ctx, `DELETE FROM task_labels WHERE org_id = $1 AND task_id = $2 AND label_id = $3`, c.OrgID, taskID, id); err != nil {
				return nil, err
			}
		}
		if err := labelTask(t, taskID, added); err != nil {
			return nil, err
		}
		if err := t.recordByCaller("task.labels_set", taskID, map[string]any{"labels": want, "added": orNone(added), "removed": orNone(removed)}); err != nil {
			return nil, err
		}
		return getTask(ctx, t, c.OrgID, taskID, t.now)
	})
	if err != nil {
		return Task{}, err
	}
	return res.(Task), nil
}

// taskLabels resolves the Labels a Task of projectID is to carry, each once: the Project's or the
// Organisation's, named by id or by name in any case, since a name names one Label among them.
func taskLabels(t *tx, projectID string, refs []string) ([]string, error) {
	out := []string{}
	if len(refs) == 0 {
		return out, nil
	}
	usable, err := collect(t.ctx, t, scanLabel, `SELECT `+labelCols+` FROM labels l
WHERE l.org_id = $1 AND (l.project_id IS NULL OR l.project_id = $2) ORDER BY l.id`, t.caller.OrgID, projectID)
	if err != nil {
		return nil, err
	}
	for _, ref := range refs {
		ref = strings.TrimSpace(ref)
		i := slices.IndexFunc(usable, func(l Label) bool { return l.ID == shortid.Canonical(ref) })
		if i < 0 {
			i = slices.IndexFunc(usable, func(l Label) bool { return strings.EqualFold(l.Name, ref) })
		}
		if i < 0 {
			if l, err := getLabel(t.ctx, t, t.caller.OrgID, ref); err == nil {
				return nil, refuse(CodeInvalid, "Label %s is another Project's; a Task carries its own Project's Labels and the Organisation's", l.Name)
			}
			return nil, refuse(CodeNotFound, "no Label %q in the Project or the Organisation", ref)
		}
		if id := usable[i].ID; !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	return out, nil
}

func labelTask(t *tx, taskID string, labels []string) error {
	for _, id := range labels {
		if _, err := t.Exec(t.ctx, `INSERT INTO task_labels (org_id, task_id, label_id) VALUES ($1, $2, $3)`, t.caller.OrgID, taskID, id); err != nil {
			return err
		}
	}
	return nil
}

func orNone(ids []string) []string {
	if ids == nil {
		return []string{}
	}
	return ids
}
