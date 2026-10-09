package core

import (
	"context"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/store"
)

func newID() string { return store.NewID() }

func itoa(n int) string { return strconv.Itoa(n) }

func itoa64(n int64) string { return strconv.FormatInt(n, 10) }

var projectKey = regexp.MustCompile(`^[A-Z][A-Z0-9]{1,9}$`)

// NewProject is a Project to create. Workflow is WorkflowDefault (the default when empty),
// WorkflowEmpty, or WorkflowCopy with CopyFrom naming the Project to copy, by id or key. Members
// are put in it, by id or name; its creator is not unless named. DefaultWorkspace names a
// Workspace by id or name; AutoComplete and Acceptance are what a Task filed in it takes when its
// filer does not say, off when nil. Color is its mark's hue; when nil it takes the hue farthest
// from those its Organisation's Projects have (pickProjectColor).
type NewProject struct {
	Key              string
	Name             string
	Color            *int
	Workflow         string
	CopyFrom         *string
	Members          []string
	DefaultWorkspace *string
	AutoComplete     *bool
	Acceptance       *bool
}

// CreateProject creates a Project (admin) with its Workflows, its settings and its Members,
// and returns it with its Members. Its key prefixes the display keys of its Tasks.
func (s *Service) CreateProject(ctx context.Context, c *auth.Caller, np NewProject, idem Idem) (ProjectDetail, error) {
	if err := mustAdmin(c); err != nil {
		return ProjectDetail{}, err
	}
	if !projectKey.MatchString(np.Key) {
		return ProjectDetail{}, refuse(CodeInvalid, "a Project key is 2 to 10 capital letters or digits, starting with a letter, such as WEB")
	}
	if err := validName("name", np.Name); err != nil {
		return ProjectDetail{}, err
	}
	if err := validProjectColor(np.Color); err != nil {
		return ProjectDetail{}, err
	}
	switch np.Workflow {
	case "":
		np.Workflow = WorkflowDefault
	case WorkflowDefault, WorkflowEmpty:
	case WorkflowCopy:
		if np.CopyFrom == nil {
			return ProjectDetail{}, refuse(CodeInvalid, "a Project whose Workflow is a copy names the Project to copy in copy_from")
		}
	default:
		return ProjectDetail{}, refuse(CodeInvalid, "a new Project's Workflow is default, empty or copy, not %q", np.Workflow)
	}
	if np.Workflow != WorkflowCopy && np.CopyFrom != nil {
		return ProjectDetail{}, refuse(CodeInvalid, "copy_from names the Project whose Workflow is copied; this Workflow is %s", np.Workflow)
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		row := projectRow{key: np.Key, name: np.Name, color: np.Color, workflow: np.Workflow}
		if np.CopyFrom != nil {
			id, err := resolveProject(ctx, t, c.OrgID, *np.CopyFrom)
			if err != nil {
				return nil, err
			}
			row.from = id
		}
		if np.DefaultWorkspace != nil {
			id, err := resolveWorkspace(ctx, t, c.OrgID, *np.DefaultWorkspace)
			if err != nil {
				return nil, err
			}
			row.defaultWorkspace = &id
		}
		row.autoComplete = np.AutoComplete != nil && *np.AutoComplete
		row.acceptance = np.Acceptance != nil && *np.Acceptance
		var members []string
		for _, ref := range np.Members {
			id, err := resolveMember(ctx, t, c.OrgID, ref)
			if err != nil {
				return nil, err
			}
			members = append(members, id)
		}
		id, err := createProject(t, row)
		if err != nil {
			return nil, err
		}
		for _, m := range members {
			if err := addProjectMember(t, id, m); err != nil {
				return nil, err
			}
		}
		return getProjectDetail(ctx, t, c.OrgID, id)
	})
	if err != nil {
		return ProjectDetail{}, err
	}
	return res.(ProjectDetail), nil
}

// projectRow is a Project to insert: from is the Project whose Workflow a copy copies.
type projectRow struct {
	key, name, workflow, from string
	color                     *int
	defaultWorkspace          *string
	autoComplete, acceptance  bool
}

// createProject creates a Project and its Workflows inside a write, recording
// project.created and workflow.changed.
func createProject(t *tx, r projectRow) (string, error) {
	if err := projectNameFree(t, "", r.key, r.name); err != nil {
		return "", err
	}
	color := 0
	if r.color != nil {
		color = *r.color
	} else {
		taken, err := collect(t.ctx, t, func(row interface{ Scan(...any) error }) (int, error) {
			var c int
			return c, row.Scan(&c)
		}, `SELECT color FROM projects WHERE org_id = $1`, t.caller.OrgID)
		if err != nil {
			return "", err
		}
		color = pickProjectColor(taken)
	}
	id := newID()
	if _, err := t.Exec(t.ctx, `INSERT INTO projects (id, org_id, key_prefix, name, color, last_number, default_workspace_id, auto_complete, acceptance, created_at)
VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9)`, id, t.caller.OrgID, r.key, r.name, color, r.defaultWorkspace, r.autoComplete, r.acceptance, ms(t.now)); err != nil {
		return "", err
	}
	payload := map[string]any{"key": r.key, "name": r.name, "color": color, "workflow": r.workflow, "auto_complete": r.autoComplete, "acceptance": r.acceptance}
	if r.from != "" {
		payload["from"] = r.from
	}
	if r.defaultWorkspace != nil {
		payload["default_workspace_id"] = *r.defaultWorkspace
	}
	if err := t.recordByCaller("project.created", id, payload); err != nil {
		return "", err
	}
	return id, seedWorkflow(t, id, r.workflow, r.from)
}

// projectNameFree refuses a key or a name another Project (not except) has, ignoring case; key ""
// checks the name alone. It compares in Go, since lower() differs between the engines.
func projectNameFree(t *tx, except, key, name string) error {
	taken, err := collect(t.ctx, t, scanProject, `SELECT `+projectCols+` FROM projects pr WHERE pr.org_id = $1`, t.caller.OrgID)
	if err != nil {
		return err
	}
	for _, p := range taken {
		switch {
		case p.ID == except:
		case key != "" && strings.EqualFold(p.Key, key):
			return refuse(CodeConflict, "a Project already has the key %s", p.Key)
		case strings.EqualFold(p.Name, name):
			return refuse(CodeConflict, "a Project is already named %q", p.Name)
		}
	}
	return nil
}

// ProjectChange is what UpdateProject changes; nil fields stay as they are. DefaultWorkspace
// names a Workspace by id or name, or "" for none.
type ProjectChange struct {
	Name             *string
	Color            *int
	DefaultWorkspace *string
	AutoComplete     *bool
	Acceptance       *bool
}

// UpdateProject changes a Project's name, colour, default Workspace, or the auto_complete and acceptance
// a Task filed in it takes when its filer does not say (admin).
func (s *Service) UpdateProject(ctx context.Context, c *auth.Caller, ref string, ch ProjectChange, idem Idem) (Project, error) {
	if err := mustAdmin(c); err != nil {
		return Project{}, err
	}
	if ch.Name != nil {
		if err := validName("name", *ch.Name); err != nil {
			return Project{}, err
		}
	}
	if err := validProjectColor(ch.Color); err != nil {
		return Project{}, err
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		id, err := resolveProject(ctx, t, c.OrgID, ref)
		if err != nil {
			return nil, err
		}
		p, err := getProject(ctx, t, c.OrgID, id)
		if err != nil {
			return nil, err
		}
		payload := map[string]any{}
		if ch.Name != nil && *ch.Name != p.Name {
			if err := projectNameFree(t, id, "", *ch.Name); err != nil {
				return nil, err
			}
			p.Name, payload["name"] = *ch.Name, *ch.Name
		}
		if ch.Color != nil && *ch.Color != p.Color {
			p.Color, payload["color"] = *ch.Color, *ch.Color
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
			if !sameRef(ws, p.DefaultWorkspaceID) {
				p.DefaultWorkspaceID, payload["default_workspace_id"] = ws, ws
			}
		}
		if ch.AutoComplete != nil && *ch.AutoComplete != p.AutoComplete {
			p.AutoComplete, payload["auto_complete"] = *ch.AutoComplete, *ch.AutoComplete
		}
		if ch.Acceptance != nil && *ch.Acceptance != p.Acceptance {
			p.Acceptance, payload["acceptance"] = *ch.Acceptance, *ch.Acceptance
		}
		if len(payload) == 0 {
			return p, nil
		}
		if _, err := t.Exec(ctx, `UPDATE projects SET name = $1, color = $2, default_workspace_id = $3, auto_complete = $4, acceptance = $5
WHERE org_id = $6 AND id = $7`, p.Name, p.Color, p.DefaultWorkspaceID, p.AutoComplete, p.Acceptance, c.OrgID, id); err != nil {
			return nil, err
		}
		if err := t.recordByCaller("project.changed", id, payload); err != nil {
			return nil, err
		}
		return p, nil
	})
	if err != nil {
		return Project{}, err
	}
	return res.(Project), nil
}

// ProjectColors is how many hues a Project's mark can take: indices 0 to 11 around the wheel.
const ProjectColors = 12

func validProjectColor(c *int) error {
	if c != nil && (*c < 0 || *c >= ProjectColors) {
		return refuse(CodeInvalid, "a Project's colour is one of %d hues, 0 to %d, not %d", ProjectColors, ProjectColors-1, *c)
	}
	return nil
}

// pickProjectColor is the colour a new Project takes, given those its Organisation's Projects
// have: of the hues the fewest Projects have, the one farthest round the wheel from every hue
// more of them have, the lowest on a tie. Until twelve Projects that is the hue farthest from all
// taken, and each Project's is its own: 0 6 3 9 1 2 4 5 7 8 10 11, the order migration 0005
// gave the Projects already there.
func pickProjectColor(taken []int) int {
	count := make([]int, ProjectColors)
	for _, c := range taken {
		if c >= 0 && c < ProjectColors {
			count[c]++
		}
	}
	fewest := slices.Min(count)
	best, bestDistance := 0, -1
	for c := range ProjectColors {
		if count[c] != fewest {
			continue
		}
		distance := ProjectColors // as far as can be: no hue is held by more
		for o := range ProjectColors {
			if count[o] > fewest {
				d := (c - o + ProjectColors) % ProjectColors
				distance = min(distance, d, ProjectColors-d)
			}
		}
		if distance > bestDistance {
			best, bestDistance = c, distance
		}
	}
	return best
}

// sameRef reports whether two optional ids name the same record, or both none.
func sameRef(a, b *string) bool {
	return (a == nil) == (b == nil) && (a == nil || *a == *b)
}

// ListProjects lists the Projects by name.
func (s *Service) ListProjects(ctx context.Context, c *auth.Caller) ([]Project, error) {
	return collect(ctx, s.store, scanProject, `SELECT `+projectCols+` FROM projects pr WHERE pr.org_id = $1 ORDER BY pr.name`, c.OrgID)
}

// GetProject returns a Project and its Members.
func (s *Service) GetProject(ctx context.Context, c *auth.Caller, ref string) (ProjectDetail, error) {
	id, err := resolveProject(ctx, s.store, c.OrgID, ref)
	if err != nil {
		return ProjectDetail{}, err
	}
	return getProjectDetail(ctx, s.store, c.OrgID, id)
}

// AddProjectMember puts a Member in a Project (admin).
func (s *Service) AddProjectMember(ctx context.Context, c *auth.Caller, projectRef, memberRef string, idem Idem) error {
	if err := mustAdmin(c); err != nil {
		return err
	}
	_, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		project, err := resolveProject(ctx, t, c.OrgID, projectRef)
		if err != nil {
			return nil, err
		}
		member, err := resolveMember(ctx, t, c.OrgID, memberRef)
		if err != nil {
			return nil, err
		}
		return nil, addProjectMember(t, project, member)
	})
	return err
}

// addProjectMember puts a Member in a Project inside a write, recording project.member_added; a
// Member already in it changes nothing.
func addProjectMember(t *tx, project, member string) error {
	if in, err := inProject(t.ctx, t, t.caller.OrgID, project, member); err != nil || in {
		return err
	}
	if _, err := t.Exec(t.ctx, `INSERT INTO project_members (org_id, project_id, member_id, added_at) VALUES ($1, $2, $3, $4)`,
		t.caller.OrgID, project, member, ms(t.now)); err != nil {
		return err
	}
	return t.recordByCaller("project.member_added", project, map[string]any{"member_id": member})
}

// RemoveProjectMember takes a Member out of a Project (admin). Their Claims on its Tasks are not
// ended.
func (s *Service) RemoveProjectMember(ctx context.Context, c *auth.Caller, projectRef, memberRef string, idem Idem) error {
	if err := mustAdmin(c); err != nil {
		return err
	}
	_, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		project, err := resolveProject(ctx, t, c.OrgID, projectRef)
		if err != nil {
			return nil, err
		}
		member, err := resolveMember(ctx, t, c.OrgID, memberRef)
		if err != nil {
			return nil, err
		}
		res, err := t.Exec(ctx, `DELETE FROM project_members WHERE org_id = $1 AND project_id = $2 AND member_id = $3`, c.OrgID, project, member)
		if err != nil {
			return nil, err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return nil, nil
		}
		return nil, t.recordByCaller("project.member_removed", project, map[string]any{"member_id": member})
	})
	return err
}
