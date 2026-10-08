package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/shortid"
	"github.com/tuongaz/darkory/internal/store"
)

// Views are saved sets of filters, sort and display for a list, each kept by one Member for
// themselves. A View is a Member's preference, not the record: writing one takes no sequence
// number and records no Activity, and nobody but its Member, an admin included, reads or changes
// it (decisions.md).

// The bounds of a View.
const (
	maxViewName    = 100
	maxViewSort    = 200
	maxViewDisplay = 16 << 10
)

// NewView is a View to save. Project names the Project whose list it is, nil for a list across
// Projects.
type NewView struct {
	Entity  string
	Project *string
	Name    string
	Filters []string
	Sort    *string
	Display map[string]any
}

// ViewChange is what UpdateView changes; nil fields stay as they are. An empty Sort clears it,
// and Display replaces the whole object.
type ViewChange struct {
	Name    *string
	Filters *[]string
	Sort    *string
	Display map[string]any
}

const viewCols = `v.id, v.entity, v.project_id, v.name, v.filters, v.sort, v.display, v.created_at, v.updated_at`

func scanView(row interface{ Scan(...any) error }) (View, error) {
	var v View
	var project, sort, display sql.NullString
	var filters string
	var created, updated int64
	if err := row.Scan(&v.ID, &v.Entity, &project, &v.Name, &filters, &sort, &display, &created, &updated); err != nil {
		return v, err
	}
	v.ProjectID, v.Sort, v.CreatedAt, v.UpdatedAt = nullString(project), nullString(sort), fromMS(created), fromMS(updated)
	if err := json.Unmarshal([]byte(filters), &v.Filters); err != nil {
		return v, fmt.Errorf("core: the filters of View %s: %w", v.ID, err)
	}
	if display.Valid {
		if err := json.Unmarshal([]byte(display.String), &v.Display); err != nil {
			return v, fmt.Errorf("core: the display of View %s: %w", v.ID, err)
		}
	}
	return v, nil
}

// getView reads one of the caller's Views; another Member's is not found, as if it did not exist.
func getView(ctx context.Context, r store.Reader, c *auth.Caller, id string) (View, error) {
	id = shortid.Canonical(id) // either form (ADR 0017)
	v, err := scanView(r.QueryRow(ctx, `SELECT `+viewCols+` FROM views v WHERE v.org_id = $1 AND v.member_id = $2 AND v.id = $3`,
		c.OrgID, c.MemberID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return v, refuse(CodeNotFound, "you have no View %s", id)
	}
	return v, err
}

// ListViews lists the caller's Views, oldest first, of entity's list and of project's when given.
func (s *Service) ListViews(ctx context.Context, c *auth.Caller, entity, project *string) ([]View, error) {
	q := &sqlQuery{}
	q.and("v.org_id = " + q.arg(c.OrgID))
	q.and("v.member_id = " + q.arg(c.MemberID))
	if entity != nil {
		if err := validEntity(*entity); err != nil {
			return nil, err
		}
		q.and("v.entity = " + q.arg(*entity))
	}
	if project != nil {
		id, err := resolveProject(ctx, s.store, c.OrgID, *project)
		if err != nil {
			return nil, err
		}
		q.and("v.project_id = " + q.arg(id))
	}
	return collect(ctx, s.store, scanView, `SELECT `+viewCols+` FROM views v WHERE `+q.sql()+` ORDER BY v.created_at, v.id`, q.args...)
}

// CreateView saves a View for the caller.
func (s *Service) CreateView(ctx context.Context, c *auth.Caller, nv NewView, idem Idem) (View, error) {
	if err := validEntity(nv.Entity); err != nil {
		return View{}, err
	}
	if nv.Filters == nil {
		nv.Filters = []string{}
	}
	cols, err := viewColumns(nv.Entity, &nv.Name, &nv.Filters, nv.Sort, nv.Display)
	if err != nil {
		return View{}, err
	}
	res, err := s.writeOwn(ctx, c, idem, func(t *tx) (any, error) {
		var project *string
		if nv.Project != nil {
			id, err := resolveProject(ctx, t, c.OrgID, *nv.Project)
			if err != nil {
				return nil, err
			}
			project = &id
		}
		if err := viewNameFree(t, "", nv.Entity, project, nv.Name); err != nil {
			return nil, err
		}
		id := newID()
		if _, err := t.Exec(ctx, `INSERT INTO views (id, org_id, member_id, entity, project_id, name, filters, sort, display, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`, id, c.OrgID, c.MemberID, nv.Entity, project, nv.Name,
			cols["filters"], cols["sort"], cols["display"], ms(t.now)); err != nil {
			return nil, err
		}
		return getView(ctx, t, c, id)
	})
	if err != nil {
		return View{}, err
	}
	return res.(View), nil
}

// UpdateView changes one of the caller's Views. The list it is of never changes.
func (s *Service) UpdateView(ctx context.Context, c *auth.Caller, id string, ch ViewChange, idem Idem) (View, error) {
	res, err := s.writeOwn(ctx, c, idem, func(t *tx) (any, error) {
		v, err := getView(ctx, t, c, id)
		if err != nil {
			return nil, err
		}
		cols, err := viewColumns(v.Entity, ch.Name, ch.Filters, ch.Sort, ch.Display)
		if err != nil {
			return nil, err
		}
		if ch.Name != nil {
			if err := viewNameFree(t, v.ID, v.Entity, v.ProjectID, *ch.Name); err != nil {
				return nil, err
			}
		}
		q := &sqlQuery{}
		sets := []string{"updated_at = " + q.arg(ms(t.now))}
		for _, col := range []string{"name", "filters", "sort", "display"} {
			if val, ok := cols[col]; ok {
				sets = append(sets, col+" = "+q.arg(val))
			}
		}
		if _, err := t.Exec(ctx, `UPDATE views SET `+strings.Join(sets, ", ")+` WHERE org_id = `+q.arg(c.OrgID)+
			` AND member_id = `+q.arg(c.MemberID)+` AND id = `+q.arg(v.ID), q.args...); err != nil {
			return nil, err
		}
		return getView(ctx, t, c, v.ID)
	})
	if err != nil {
		return View{}, err
	}
	return res.(View), nil
}

// DeleteView deletes one of the caller's Views.
func (s *Service) DeleteView(ctx context.Context, c *auth.Caller, id string, idem Idem) error {
	_, err := s.writeOwn(ctx, c, idem, func(t *tx) (any, error) {
		if _, err := getView(ctx, t, c, id); err != nil {
			return nil, err
		}
		_, err := t.Exec(ctx, `DELETE FROM views WHERE org_id = $1 AND member_id = $2 AND id = $3`, c.OrgID, c.MemberID, id)
		return nil, err
	})
	return err
}

func validEntity(entity string) error {
	if entity != EntityTasks {
		return refuse(CodeInvalid, "a View is of the tasks list, not %q", entity)
	}
	return nil
}

// viewColumns checks the fields given and returns their column values by column name, leaving
// out those not given; a sort of "" is stored as none.
func viewColumns(entity string, name *string, filters *[]string, sort *string, display map[string]any) (map[string]any, error) {
	cols := map[string]any{}
	if name != nil {
		if strings.TrimSpace(*name) == "" || utf8.RuneCountInString(*name) > maxViewName || strings.ContainsFunc(*name, unicode.IsControl) {
			return nil, refuse(CodeInvalid, "a View's name is 1 to %d characters, on one line", maxViewName)
		}
		cols["name"] = *name
	}
	if filters != nil {
		if _, err := parseFilters(entity, *filters); err != nil {
			return nil, err
		}
		// Kept with canonical ids, as storage keeps every id (ADR 0017).
		b, err := json.Marshal(FilterIDs(entity, *filters, shortid.Canonical))
		if err != nil {
			return nil, err
		}
		cols["filters"] = string(b)
	}
	if sort != nil {
		if len(*sort) > maxViewSort {
			return nil, refuse(CodeInvalid, "a View's sort is at most %d bytes", maxViewSort)
		}
		cols["sort"] = sql.NullString{String: *sort, Valid: *sort != ""}
	}
	if display != nil {
		b, err := json.Marshal(display)
		if err != nil {
			return nil, refuse(CodeInvalid, "a View's display is a JSON object")
		}
		if len(b) > maxViewDisplay {
			return nil, refuse(CodeInvalid, "a View's display is at most %d bytes as JSON", maxViewDisplay)
		}
		cols["display"] = string(b)
	}
	return cols, nil
}

// viewNameFree refuses a name another of the caller's Views (not except) of the same list has,
// ignoring case.
func viewNameFree(t *tx, except, entity string, project *string, name string) error {
	projectID := ""
	if project != nil {
		projectID = *project
	}
	var n int
	if err := t.QueryRow(t.ctx, `SELECT COUNT(*) FROM views WHERE org_id = $1 AND member_id = $2 AND entity = $3
AND COALESCE(project_id, '') = $4 AND lower(name) = lower($5) AND id <> $6`,
		t.caller.OrgID, t.caller.MemberID, entity, projectID, name, except).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return refuse(CodeConflict, "you already have a View named %q of this list", name)
	}
	return nil
}

// writeOwn runs fn as a write to the caller's own preferences, which are not the record: it
// takes no sequence number and records no Activity, so it neither queues behind the
// Organisation's writes nor wakes anyone waiting on them. fn's result is kept under idem in the
// same transaction, and a refusal of a rule's after the rollback, as write does. Of two requests
// under one key at once, the second's key fails to insert and it answers with the first's
// response.
func (s *Service) writeOwn(ctx context.Context, c *auth.Caller, idem Idem, fn func(t *tx) (any, error)) (any, error) {
	var result any
	err := s.store.WriteNoSeq(ctx, func(stx store.Tx) error {
		t := &tx{Tx: stx, ctx: ctx, caller: c, now: s.clock.Now()}
		if idem.Key != "" {
			if err := lookupIdem(ctx, stx, c, idem, t.now); err != nil {
				return err
			}
		}
		res, err := fn(t)
		if err != nil {
			return err
		}
		result = res
		stmts, err := idemStmts(c, idem, res, t.now)
		if err != nil {
			return err
		}
		for _, st := range stmts {
			if _, err := stx.Exec(ctx, st.SQL, st.Args...); err != nil {
				return err
			}
		}
		return nil
	})
	if store.IsUniqueViolation(err) {
		return nil, s.afterRefusal(ctx, c, idem, err)
	}
	if err != nil {
		return nil, s.keepRefusal(ctx, c, idem, err)
	}
	return result, nil
}
