package store_test

import (
	"context"
	"fmt"
	"maps"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// schema is a database's tables, normalised so SQLite and Postgres compare equal when the
// migrations made the same thing on both (ADR 0009).
type schema map[string]*table

type table struct {
	Columns     map[string]string // name → "type null|not null"
	PrimaryKey  []string
	Indexes     map[string]string // name → "unique? partial? (columns)"
	ForeignKeys []string          // "column → table.column", sorted
}

func TestSchemaIsTheSameOnBothEngines(t *testing.T) {
	lite := describe(t, storetest.Open(t, store.SQLite))
	if os.Getenv(storetest.PostgresURLEnv) == "" {
		t.Skipf("%s is not set; nothing to compare SQLite's schema with", storetest.PostgresURLEnv)
	}
	pg := describe(t, storetest.Open(t, store.Postgres))

	for _, name := range union(lite, pg) {
		l, p := lite[name], pg[name]
		switch {
		case l == nil:
			t.Errorf("table %s exists only on Postgres", name)
		case p == nil:
			t.Errorf("table %s exists only on SQLite", name)
		default:
			if a, b := l.String(), p.String(); a != b {
				t.Errorf("table %s differs\nsqlite:\n%s\npostgres:\n%s", name, a, b)
			}
		}
	}
}

// The parity above compares each foreign key with its delete rule; this pins the one rule that is
// not NO ACTION: an ended Task's last Step, deleted with no move for it, leaves last_step_id null.
func TestTheLastStepIsSetNullWhenItsStepGoes(t *testing.T) {
	storetest.Each(t, func(t *testing.T, s *store.Store) {
		tasks := describe(t, s)["tasks"]
		if tasks == nil || !slices.Contains(tasks.ForeignKeys, "last_step_id → steps.id on delete SET NULL") {
			t.Fatalf("tasks' foreign keys %q lack last_step_id → steps.id on delete SET NULL", tasks.ForeignKeys)
		}
	})
}

// Every query filters by org_id (plan invariant 5), so every table carries it. The exceptions
// hold no Organisation's data: organisations itself and the migration record.
func TestEveryTableCarriesOrgID(t *testing.T) {
	storetest.Each(t, func(t *testing.T, s *store.Store) {
		sch := describe(t, s)
		if len(sch) < 20 {
			t.Fatalf("only %d tables", len(sch))
		}
		for name, tb := range sch {
			if name == "organisations" || name == "schema_migrations" {
				continue
			}
			if tb.Columns["org_id"] != "text not null" {
				t.Errorf("table %s: org_id is %q, want text not null", name, tb.Columns["org_id"])
			}
		}
	})
}

func (t *table) String() string {
	var b strings.Builder
	for _, c := range slices.Sorted(maps.Keys(t.Columns)) {
		fmt.Fprintf(&b, "  column %s %s\n", c, t.Columns[c])
	}
	fmt.Fprintf(&b, "  primary key (%s)\n", strings.Join(t.PrimaryKey, ", "))
	for _, i := range slices.Sorted(maps.Keys(t.Indexes)) {
		fmt.Fprintf(&b, "  index %s %s\n", i, t.Indexes[i])
	}
	for _, f := range t.ForeignKeys {
		fmt.Fprintf(&b, "  foreign key %s\n", f)
	}
	return b.String()
}

func union(a, b schema) []string {
	names := slices.Collect(maps.Keys(a))
	for n := range b {
		if a[n] == nil {
			names = append(names, n)
		}
	}
	slices.Sort(names)
	return names
}

func describe(t *testing.T, s *store.Store) schema {
	t.Helper()
	ctx := t.Context()
	var sch schema
	var err error
	if s.Engine() == store.SQLite {
		sch, err = describeSQLite(ctx, s)
	} else {
		sch, err = describePostgres(ctx, s)
	}
	if err != nil {
		t.Fatalf("describe %s: %v", s.Engine(), err)
	}
	return sch
}

func nullability(notNull bool) string {
	if notNull {
		return "not null"
	}
	return "null"
}

func indexKind(unique, partial bool, cols []string) string {
	kind := ""
	if unique {
		kind += "unique "
	}
	if partial {
		kind += "partial "
	}
	return kind + "(" + strings.Join(cols, ", ") + ")"
}

func strings1(ctx context.Context, s *store.Store, query string, args ...any) ([]string, error) {
	rows, err := s.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func describeSQLite(ctx context.Context, s *store.Store) (schema, error) {
	names, err := strings1(ctx, s, `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
	if err != nil {
		return nil, err
	}
	sch := schema{}
	for _, name := range names {
		tb := &table{Columns: map[string]string{}, Indexes: map[string]string{}}
		sch[name] = tb

		rows, err := s.Query(ctx, `SELECT name, type, "notnull", pk FROM pragma_table_info($1)`, name)
		if err != nil {
			return nil, err
		}
		pk := map[int]string{}
		for rows.Next() {
			var col, typ string
			var notNull bool
			var pkPos int
			if err := rows.Scan(&col, &typ, &notNull, &pkPos); err != nil {
				rows.Close()
				return nil, err
			}
			tb.Columns[col] = strings.ToLower(typ) + " " + nullability(notNull)
			if pkPos > 0 {
				pk[pkPos] = col
			}
		}
		rows.Close()
		for i := 1; i <= len(pk); i++ {
			tb.PrimaryKey = append(tb.PrimaryKey, pk[i])
		}

		// Only the indexes the migrations create: origin 'c', not those behind a primary key or
		// UNIQUE constraint.
		rows, err = s.Query(ctx, `SELECT name, "unique", partial FROM pragma_index_list($1) WHERE origin = 'c'`, name)
		if err != nil {
			return nil, err
		}
		type idx struct {
			name            string
			unique, partial bool
		}
		var idxs []idx
		for rows.Next() {
			var i idx
			if err := rows.Scan(&i.name, &i.unique, &i.partial); err != nil {
				rows.Close()
				return nil, err
			}
			idxs = append(idxs, i)
		}
		rows.Close()
		for _, i := range idxs {
			cols, err := strings1(ctx, s, `SELECT name FROM pragma_index_info($1) ORDER BY seqno`, i.name)
			if err != nil {
				return nil, err
			}
			tb.Indexes[i.name] = indexKind(i.unique, i.partial, cols)
		}

		fks, err := strings1(ctx, s, `SELECT "from" || ' → ' || "table" || '.' || "to" || ' on delete ' || on_delete FROM pragma_foreign_key_list($1)`, name)
		if err != nil {
			return nil, err
		}
		slices.Sort(fks)
		tb.ForeignKeys = fks
	}
	return sch, nil
}

func describePostgres(ctx context.Context, s *store.Store) (schema, error) {
	names, err := strings1(ctx, s, `SELECT table_name FROM information_schema.tables
		WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`)
	if err != nil {
		return nil, err
	}
	sch := schema{}
	for _, name := range names {
		tb := &table{Columns: map[string]string{}, Indexes: map[string]string{}}
		sch[name] = tb

		rows, err := s.Query(ctx, `SELECT column_name, data_type, is_nullable = 'NO' FROM information_schema.columns
			WHERE table_schema = current_schema() AND table_name = $1`, name)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var col, typ string
			var notNull bool
			if err := rows.Scan(&col, &typ, &notNull); err != nil {
				rows.Close()
				return nil, err
			}
			tb.Columns[col] = strings.ToLower(typ) + " " + nullability(notNull)
		}
		rows.Close()

		const tableOID = `(SELECT c.oid FROM pg_class c WHERE c.relname = $1 AND c.relnamespace = current_schema()::regnamespace)`
		tb.PrimaryKey, err = strings1(ctx, s, `SELECT a.attname FROM pg_index i
			JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) ON true
			JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
			WHERE i.indrelid = `+tableOID+` AND i.indisprimary ORDER BY k.ord`, name)
		if err != nil {
			return nil, err
		}

		// Only the indexes the migrations create, not those behind a constraint.
		rows, err = s.Query(ctx, `SELECT c.relname, i.indisunique, i.indpred IS NOT NULL,
				array_to_string(ARRAY(SELECT pg_get_indexdef(i.indexrelid, k, true) FROM generate_series(1, i.indnatts) AS k ORDER BY k), ',')
			FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
			WHERE i.indrelid = `+tableOID+`
			AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)`, name)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var idx, cols string
			var unique, partial bool
			if err := rows.Scan(&idx, &unique, &partial, &cols); err != nil {
				rows.Close()
				return nil, err
			}
			tb.Indexes[idx] = indexKind(unique, partial, strings.Split(cols, ","))
		}
		rows.Close()

		fks, err := strings1(ctx, s, `SELECT a.attname || ' → ' || ft.relname || '.' || fa.attname || ' on delete ' ||
				CASE k.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
					WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' ELSE 'unknown ' || k.confdeltype::text END
			FROM pg_constraint k
			JOIN pg_class ft ON ft.oid = k.confrelid
			JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
			JOIN pg_attribute fa ON fa.attrelid = k.confrelid AND fa.attnum = k.confkey[1]
			WHERE k.contype = 'f' AND k.conrelid = `+tableOID, name)
		if err != nil {
			return nil, err
		}
		slices.Sort(fks)
		tb.ForeignKeys = fks
	}
	return sch, nil
}
