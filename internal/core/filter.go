package core

import (
	"net/url"
	"strings"
	"time"
)

// Filters narrow a list by tokens `field:op:v1,v2…`, the grammar of the `filter` parameter of
// listTasks and listFeatures (api/openapi.yaml). Each value is percent-encoded on its own, so a
// token splits on its first two colons and then on commas before any value is decoded. Each
// field is one SQL predicate over the list's rows, the same on both engines, with every value
// bound rather than written into the query. References are ids and are not looked up: an id that
// names nothing matches nothing, so a View naming a Status since removed still opens.

// The bounds of one list's filter, which keep its query small.
const (
	MaxFilters      = 50
	MaxFilterValues = 100
	maxFilterValue  = 200
)

// The lists a filter narrows, which are also the lists a View is of.
const (
	EntityTasks    = "tasks"
	EntityFeatures = "features"
)

// filter is one token, checked.
type filter struct {
	token  string
	field  filterField
	op     string
	values []string
}

type fieldKind int

const (
	// idField takes record ids, and words when it has any (none for holder).
	idField fieldKind = iota
	// labelField takes any short text, such as a model label.
	labelField
	// enumField takes only its words (true and false for a boolean).
	enumField
	textField
	dateField
)

// filterField is a field a list can be filtered by.
type filterField struct {
	name  string
	kind  fieldKind
	words []string
	// match is the predicate of an id, label or enum field: true for a row whose value is one of
	// vals, false otherwise, never null, so that NOT negates it, and a row with no value is
	// matched by not and nin.
	match func(q *sqlQuery, vals []string) string
	// cols are a text field's columns, or a date field's one expression, in milliseconds since
	// the epoch and null when the row has no such time.
	cols []string
}

// The operators each kind of field takes, with how many values: 1, or 0 for one or more.
var fieldOps = map[fieldKind]map[string]int{
	idField:    {"is": 1, "not": 1, "in": 0, "nin": 0},
	labelField: {"is": 1, "not": 1, "in": 0, "nin": 0},
	enumField:  {"is": 1, "not": 1, "in": 0, "nin": 0},
	textField:  {"contains": 1},
	dateField:  {"before": 1, "after": 1, "gte": 1, "lte": 1, "btw": 2, "last": 1},
}

// The periods `last` takes.
var lastPeriods = map[string]time.Duration{"7d": 7 * 24 * time.Hour, "30d": 30 * 24 * time.Hour, "90d": 90 * 24 * time.Hour}

// sqlQuery gathers a list query's conditions and the arguments they bind as $1, $2…
type sqlQuery struct {
	where []string
	args  []any
	now   time.Time
	nowAt string
}

// arg binds v and returns its placeholder.
func (q *sqlQuery) arg(v any) string {
	q.args = append(q.args, v)
	return "$" + itoa(len(q.args))
}

// list binds each of vs and returns their placeholders, comma-separated.
func (q *sqlQuery) list(vs []string) string {
	marks := make([]string, len(vs))
	for i, v := range vs {
		marks[i] = q.arg(v)
	}
	return strings.Join(marks, ", ")
}

// nowArg is the placeholder of the query's now, bound once.
func (q *sqlQuery) nowArg() string {
	if q.nowAt == "" {
		q.nowAt = q.arg(ms(q.now))
	}
	return q.nowAt
}

func (q *sqlQuery) and(cond string) { q.where = append(q.where, cond) }

func (q *sqlQuery) sql() string { return strings.Join(q.where, " AND ") }

// column matches a column against ids or labels; a nullable column's null matches none of them.
func column(col string, nullable bool) func(*sqlQuery, []string) string {
	return func(q *sqlQuery, vals []string) string {
		in := col + " IN (" + q.list(vals) + ")"
		if nullable {
			return "(" + col + " IS NOT NULL AND " + in + ")"
		}
		return in
	}
}

// word is one value of an enum field, with its predicate.
type word struct {
	value string
	pred  func(q *sqlQuery) string
}

// enum is a field of words, matched by any of their predicates.
func enum(name string, ws ...word) filterField {
	f := filterField{name: name, kind: enumField}
	preds := map[string]func(*sqlQuery) string{}
	for _, w := range ws {
		f.words = append(f.words, w.value)
		preds[w.value] = w.pred
	}
	f.match = func(q *sqlQuery, vals []string) string {
		ors := make([]string, len(vals))
		for i, v := range vals {
			ors[i] = preds[v](q)
		}
		return "(" + strings.Join(ors, " OR ") + ")"
	}
	return f
}

// enumColumn is an enum field held in a column, its words the column's values.
func enumColumn(name, col string, words ...string) filterField {
	ws := make([]word, len(words))
	for i, w := range words {
		ws[i] = word{w, func(q *sqlQuery) string { return col + " = " + q.arg(w) }}
	}
	return enum(name, ws...)
}

// boolean is a field that is true or false, cond saying when it is true; cond is never null.
func boolean(name string, cond func(q *sqlQuery) string) filterField {
	return enum(name, word{"true", cond}, word{"false", func(q *sqlQuery) string { return "NOT (" + cond(q) + ")" }})
}

func fixed(cond string) func(*sqlQuery) string { return func(*sqlQuery) string { return cond } }

// liveClaim holds when the Task t has a live Claim: one whose expiry, if any, is still ahead.
func liveClaim(q *sqlQuery) string {
	return "(t.claim_holder_id IS NOT NULL AND (t.claim_expires_at IS NULL OR t.claim_expires_at > " + q.nowArg() + "))"
}

// lapsedSince holds when the open Task t has no live Claim and its latest Claim lapsed after
// cut: the lapse recorded (the Claim ended lapsed, the Task freed) or not yet (the Task's Claim
// still current, its expiry passed).
func lapsedSince(q *sqlQuery, cut time.Time) string {
	c := q.arg(ms(cut))
	return `(t.state = 'open' AND ((t.claim_holder_id IS NOT NULL AND t.claim_expires_at IS NOT NULL
	AND t.claim_expires_at <= ` + q.nowArg() + ` AND t.claim_expires_at > ` + c + `)
OR (t.claim_holder_id IS NULL AND EXISTS (SELECT 1 FROM claims xl WHERE xl.org_id = t.org_id AND xl.task_id = t.id
	AND xl.how_ended = 'lapsed' AND xl.ended_at > ` + c + `
	AND NOT EXISTS (SELECT 1 FROM claims xn WHERE xn.org_id = t.org_id AND xn.task_id = t.id
		AND (xn.started_at > xl.started_at OR (xn.started_at = xl.started_at AND xn.id > xl.id)))))))`
}

// taskFields are the fields listTasks filters by, over a Task t and its Feature f.
var taskFields = fieldMap(
	filterField{name: "status", kind: idField, match: column("t.status_id", false)},
	enum("status_kind", kindWord("backlog"), kindWord("todo"), kindWord("in_progress"), kindWord("done"), kindWord("dropped")),
	filterField{name: "skill", kind: idField, match: column("t.skill_id", true)},
	filterField{name: "holder", kind: idField, words: []string{"none"}, match: func(q *sqlQuery, vals []string) string {
		var ors, ids []string
		for _, v := range vals {
			if v == "none" {
				ors = append(ors, "NOT "+liveClaim(q))
			} else {
				ids = append(ids, v)
			}
		}
		if len(ids) > 0 {
			ors = append(ors, "("+liveClaim(q)+" AND t.claim_holder_id IN ("+q.list(ids)+"))")
		}
		return "(" + strings.Join(ors, " OR ") + ")"
	}},
	filterField{name: "aimed_at", kind: idField, match: column("t.aimed_at_id", true)},
	filterField{name: "feature", kind: idField, match: column("t.feature_id", false)},
	filterField{name: "owner", kind: idField, match: column("f.owner_id", false)},
	filterField{name: "team", kind: idField, match: column("f.team_id", false)},
	filterField{name: "filed_by", kind: idField, match: column("t.filed_by", false)},
	boolean("blocked", fixed(`EXISTS (SELECT 1 FROM blocks xb JOIN tasks xbt ON xbt.id = xb.blocker_task_id
	WHERE xb.org_id = t.org_id AND xb.task_id = t.id AND xbt.state = 'open')`)),
	boolean("blocks", fixed(`(t.state = 'open' AND EXISTS (SELECT 1 FROM blocks xk JOIN tasks xkt ON xkt.id = xk.task_id
	WHERE xk.org_id = t.org_id AND xk.blocker_task_id = t.id AND xkt.state = 'open'))`)),
	enum("kind",
		word{"work", fixed("(t.kind = 'work' AND t.aimed_at_id IS NULL)")},
		word{"breakdown", fixed("t.kind = 'breakdown'")},
		word{"retro", fixed("t.kind = 'retrospective'")},
		word{"question", fixed("t.aimed_at_id IS NOT NULL")}),
	enum("claim",
		word{"held", liveClaim},
		word{"unheld", func(q *sqlQuery) string { return "NOT " + liveClaim(q) }},
		word{"lapsed_24h", func(q *sqlQuery) string { return lapsedSince(q, q.now.Add(-24*time.Hour)) }},
		word{"live_session", func(q *sqlQuery) string {
			return "(" + liveClaim(q) + ` AND t.claim_expires_at IS NOT NULL
	AND EXISTS (SELECT 1 FROM members xm WHERE xm.org_id = t.org_id AND xm.id = t.claim_holder_id AND xm.kind = 'agent'))`
		}}),
	filterField{name: "workspace", kind: idField, match: func(q *sqlQuery, vals []string) string {
		return `EXISTS (SELECT 1 FROM task_workspaces xw WHERE xw.org_id = t.org_id AND xw.task_id = t.id
	AND xw.workspace_id IN (` + q.list(vals) + "))"
	}},
	filterField{name: "model", kind: labelField, match: func(q *sqlQuery, vals []string) string {
		return "(" + liveClaim(q) + ` AND EXISTS (SELECT 1 FROM claims xc WHERE xc.org_id = t.org_id AND xc.id = t.claim_id
	AND xc.model_label IN (` + q.list(vals) + ")))"
	}},
	filterField{name: "filed_at", kind: dateField, cols: []string{"t.created_at"}},
	// The latest Activity about the Task: Heartbeats and Darkory's own Status moves write none.
	filterField{name: "updated_at", kind: dateField, cols: []string{
		"COALESCE((SELECT MAX(xa.at) FROM activity xa WHERE xa.org_id = t.org_id AND xa.subject_id = t.id), t.created_at)"}},
	filterField{name: "completed_at", kind: dateField, cols: []string{"CASE WHEN t.state = 'done' THEN t.ended_at END"}},
	filterField{name: "q", kind: textField, cols: []string{"t.display_key", "t.title", "t.description"}},
)

// kindWord matches the kind of the Task t's Status.
func kindWord(kind string) word {
	return word{kind, func(q *sqlQuery) string {
		return "EXISTS (SELECT 1 FROM statuses xs WHERE xs.org_id = t.org_id AND xs.id = t.status_id AND xs.kind = " + q.arg(kind) + ")"
	}}
}

// featureFields are the fields listFeatures filters by, over a Feature f.
var featureFields = fieldMap(
	enumColumn("state", "f.state", "open", "shipped", "dropped"),
	filterField{name: "owner", kind: idField, match: column("f.owner_id", false)},
	filterField{name: "team", kind: idField, match: column("f.team_id", false)},
	boolean("quick", fixed("f.quick = TRUE")),
	boolean("ship_when_done", fixed("f.ship_when_done = TRUE")),
	filterField{name: "filed_at", kind: dateField, cols: []string{"f.created_at"}},
	filterField{name: "ended_at", kind: dateField, cols: []string{"f.ended_at"}},
	filterField{name: "q", kind: textField, cols: []string{"f.display_key", "f.title", "f.description"}},
)

// fieldSet is a list's fields, by name, with their names in order for messages.
type fieldSet struct {
	byName map[string]filterField
	names  string
}

var fieldsOf = map[string]fieldSet{EntityTasks: taskFields, EntityFeatures: featureFields}

func fieldMap(fs ...filterField) fieldSet {
	set := fieldSet{byName: map[string]filterField{}}
	names := make([]string, len(fs))
	for i, f := range fs {
		set.byName[f.name] = f
		names[i] = f.name
	}
	set.names = strings.Join(names, ", ")
	return set
}

// parseFilters checks tokens against the grammar of entity's list.
func parseFilters(entity string, tokens []string) ([]filter, error) {
	if len(tokens) > MaxFilters {
		return nil, refuse(CodeInvalid, "at most %d filters, not %d", MaxFilters, len(tokens))
	}
	fields := fieldsOf[entity]
	out := make([]filter, 0, len(tokens))
	for _, tok := range tokens {
		name, rest, ok := strings.Cut(tok, ":")
		f, known := fields.byName[name]
		if !known {
			return nil, refuse(CodeInvalid, "filter %q: %s have no field %q; the fields are %s", tok, entity, name, fields.names)
		}
		op, raw, ok2 := strings.Cut(rest, ":")
		arity, takes := fieldOps[f.kind][op]
		if !ok || !takes {
			return nil, refuse(CodeInvalid, "filter %q: %s takes %s", tok, name, opsOf(f.kind))
		}
		if !ok2 || raw == "" {
			return nil, refuse(CodeInvalid, "filter %q: %s needs %s", tok, op, valuesWord(arity))
		}
		parts := strings.Split(raw, ",")
		if (arity > 0 && len(parts) != arity) || len(parts) > MaxFilterValues {
			return nil, refuse(CodeInvalid, "filter %q: %s takes %s, not %d", tok, op, valuesWord(arity), len(parts))
		}
		vals := make([]string, len(parts))
		for i, p := range parts {
			v, err := url.PathUnescape(p)
			if err != nil {
				return nil, refuse(CodeInvalid, "filter %q: %q is not percent-encoded rightly", tok, p)
			}
			if err := checkValue(f, op, v); err != nil {
				return nil, refuse(CodeInvalid, "filter %q: %s", tok, err.Message)
			}
			vals[i] = v
		}
		if op == "btw" && dateOf(vals[0]).After(dateOf(vals[1])) {
			return nil, refuse(CodeInvalid, "filter %q: btw takes the earlier time first", tok)
		}
		out = append(out, filter{token: tok, field: f, op: op, values: vals})
	}
	return out, nil
}

// checkValue checks one decoded value of a token for field f under op.
func checkValue(f filterField, op, v string) *Error {
	if v == "" {
		return refuse(CodeInvalid, "a value is empty")
	}
	if len(v) > maxFilterValue {
		return refuse(CodeInvalid, "a value is at most %d bytes", maxFilterValue)
	}
	switch f.kind {
	case idField:
		if !looksLikeID(v) && !contains(f.words, v) {
			if len(f.words) > 0 {
				return refuse(CodeInvalid, "%s takes ids or %s, not %q", f.name, strings.Join(f.words, ", "), v)
			}
			return refuse(CodeInvalid, "%s takes ids, not names such as %q", f.name, v)
		}
	case enumField:
		if !contains(f.words, v) {
			return refuse(CodeInvalid, "%s is one of %s, not %q", f.name, strings.Join(f.words, ", "), v)
		}
	case dateField:
		if op == "last" {
			if _, ok := lastPeriods[v]; !ok {
				return refuse(CodeInvalid, "last takes 7d, 30d or 90d, not %q", v)
			}
		} else if _, err := time.Parse(time.RFC3339, v); err != nil {
			return refuse(CodeInvalid, "%q is not an RFC 3339 time with its offset, such as 2026-10-07T09:00:00+11:00", v)
		}
	}
	return nil
}

func contains(ws []string, v string) bool {
	for _, w := range ws {
		if w == v {
			return true
		}
	}
	return false
}

func dateOf(v string) time.Time {
	t, _ := time.Parse(time.RFC3339, v)
	return t
}

func opsOf(k fieldKind) string {
	switch k {
	case textField:
		return "contains"
	case dateField:
		return "before, after, gte, lte, btw or last"
	}
	return "is, not, in or nin"
}

func valuesWord(arity int) string {
	switch arity {
	case 0:
		return "one or more values"
	case 1:
		return "one value"
	}
	return itoa(arity) + " values"
}

// narrow adds each filter's condition to q.
func (q *sqlQuery) narrow(fs []filter) {
	for _, f := range fs {
		q.and(q.condition(f))
	}
}

func (q *sqlQuery) condition(f filter) string {
	switch f.field.kind {
	case textField:
		like := q.arg("%" + likeEscaper.Replace(f.values[0]) + "%")
		ors := make([]string, len(f.field.cols))
		for i, c := range f.field.cols {
			ors[i] = "lower(" + c + ") LIKE lower(CAST(" + like + ` AS TEXT)) ESCAPE '\'`
		}
		return "(" + strings.Join(ors, " OR ") + ")"
	case dateField:
		col := f.field.cols[0]
		at := func(v string) string { return q.arg(ms(dateOf(v))) }
		switch f.op {
		case "before":
			return col + " < " + at(f.values[0])
		case "after":
			return col + " > " + at(f.values[0])
		case "gte":
			return col + " >= " + at(f.values[0])
		case "lte":
			return col + " <= " + at(f.values[0])
		case "btw":
			return "(" + col + " >= " + at(f.values[0]) + " AND " + col + " <= " + at(f.values[1]) + ")"
		default: // last
			return col + " >= " + q.arg(ms(q.now.Add(-lastPeriods[f.values[0]])))
		}
	}
	match := f.field.match(q, f.values)
	if f.op == "not" || f.op == "nin" {
		return "NOT (" + match + ")"
	}
	return match
}

// likeEscaper makes a value match itself under LIKE … ESCAPE '\'.
var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
