package store_test

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// migrateTo6 applies migration 0006 to a database at 0005, from its files.
func migrateTo6(t *testing.T, s *store.Store) {
	t.Helper()
	res, err := s.MigrateFS(t.Context(), upTo(t, 6), now)
	if err != nil {
		t.Fatalf("migrating to 0006: %v", err)
	}
	if !slices.Equal(res.Applied, []int{6}) {
		t.Fatalf("applied %v, want 6", res.Applied)
	}
}

// v5 is a database written under 0005, with each kind of record migration 0006 moves: two Teams;
// a Feature with a Break down and work Tasks in every kind of Status, one of them held, one aimed
// at a Member, one blocked by it and one handed over; a quick Feature with its one Task and
// Evidence on the Feature itself; a shipped Feature with an open Retrospective that was reviewed
// once; Views of both lists.
var v5 = []string{
	`INSERT INTO organisations (id, name, seq, created_at) VALUES ('o', 'Acme', 7, 0)`,
	`INSERT INTO members (id, org_id, name, kind, admin, created_at, updated_at) VALUES
		('ada', 'o', 'ada', 'human', TRUE, 0, 0), ('bob', 'o', 'bob', 'agent', FALSE, 0, 0),
		('cat', 'o', 'cat', 'agent', FALSE, 0, 0), ('dan', 'o', 'dan', 'human', FALSE, 0, 0)`,
	`INSERT INTO sessions (id, org_id, member_id, chosen_id, kind, created_at, last_seen_at) VALUES
		('s-bob', 'o', 'bob', 'bob-1', 'token', 0, 0)`,
	`INSERT INTO skills (id, org_id, name, kind, base_skill_id, builtin, current_version, created_at) VALUES
		('sk-breakdown', 'o', 'breakdown', 'generic', NULL, TRUE, 1, 0), ('sk-retro', 'o', 'retro', 'generic', NULL, TRUE, 1, 0),
		('sk-sr', 'o', 'skill-review', 'generic', NULL, TRUE, 1, 0), ('sk-build', 'o', 'build', 'generic', NULL, FALSE, 1, 0),
		('sk-review', 'o', 'review', 'generic', NULL, FALSE, 1, 0), ('sk-qa', 'o', 'qa', 'generic', NULL, FALSE, 1, 0)`,
	`INSERT INTO skills (id, org_id, name, kind, base_skill_id, builtin, current_version, created_at) VALUES
		('sk-qa-acme', 'o', 'qa-acme', 'company', 'sk-qa', FALSE, 1, 0)`,
	`INSERT INTO statuses (id, org_id, name, kind, position, created_at) VALUES
		('st-backlog', 'o', 'Backlog', 'backlog', 1, 0), ('st-todo', 'o', 'Todo', 'todo', 2, 0),
		('st-prog', 'o', 'In progress', 'in_progress', 3, 0), ('st-review', 'o', 'In review', 'in_progress', 4, 0),
		('st-done', 'o', 'Done', 'done', 5, 0), ('st-dropped', 'o', 'Dropped', 'dropped', 6, 0)`,
	`INSERT INTO workspaces (id, org_id, name, kind, path, mode, default_branch, created_at) VALUES
		('ws-web', 'o', 'web', 'git', '/src/web', 'plain', 'main', 0), ('ws-api', 'o', 'api', 'git', '/src/api', 'plain', 'main', 0)`,
	`INSERT INTO teams (id, org_id, key_prefix, name, last_number, default_workspace_id, ship_when_done, created_at) VALUES
		('tm-web', 'o', 'WEB', 'Web', 20, 'ws-web', TRUE, 0), ('tm-ops', 'o', 'OPS', 'Ops', 2, NULL, FALSE, 0)`,
	`INSERT INTO team_members (org_id, team_id, member_id, added_at) VALUES
		('o', 'tm-web', 'ada', 0), ('o', 'tm-web', 'bob', 0), ('o', 'tm-ops', 'cat', 0)`,
	`INSERT INTO features (id, org_id, team_id, display_key, title, description, owner_id, state, rank, filed_by, created_at, ended_at,
		quick, ship_when_done) VALUES
		('q1', 'o', 'tm-web', 'WEB-10', 'Fix the typo', '', 'dan', 'open', 1, 'dan', 900, NULL, TRUE, TRUE),
		('f1', 'o', 'tm-web', 'WEB-1', 'Checkout', 'Pay at the end', 'ada', 'open', 2, 'ada', 1000, NULL, FALSE, TRUE),
		('f2', 'o', 'tm-web', 'WEB-12', 'Search', '', 'ada', 'shipped', 3, 'bob', 4000, 5000, FALSE, FALSE),
		('f3', 'o', 'tm-ops', 'OPS-1', 'Runbook', '', 'cat', 'open', 1, 'cat', 1000, NULL, FALSE, FALSE)`,
	`INSERT INTO tasks (id, org_id, feature_id, display_key, kind, title, state, skill_id, aimed_at_id, filed_by, waiting_since,
		created_at, ended_at, status_id) VALUES
		('t-bd', 'o', 'f1', 'WEB-2', 'breakdown', 'Break down: Checkout', 'done', 'sk-breakdown', NULL, 'ada', 1000, 1000, 1200, 'st-done'),
		('t-backlog', 'o', 'f1', 'WEB-3', 'work', 'Later', 'open', 'sk-build', NULL, 'bob', 1200, 1200, NULL, 'st-backlog'),
		('t-todo', 'o', 'f1', 'WEB-4', 'work', 'Cart', 'open', 'sk-build', NULL, 'bob', 1300, 1300, NULL, 'st-todo'),
		('t-held', 'o', 'f1', 'WEB-5', 'work', 'Test the cart', 'open', 'sk-qa-acme', NULL, 'bob', 1400, 1400, NULL, 'st-prog'),
		('t-review', 'o', 'f1', 'WEB-6', 'work', 'Pay', 'open', 'sk-review', NULL, 'bob', 1600, 1450, NULL, 'st-review'),
		('t-done', 'o', 'f1', 'WEB-7', 'work', 'Prices', 'done', 'sk-build', NULL, 'bob', 1250, 1250, 1700, 'st-done'),
		('t-dropped', 'o', 'f1', 'WEB-8', 'work', 'Coupons', 'dropped', 'sk-build', NULL, 'bob', 1260, 1260, 1800, 'st-dropped'),
		('t-aimed', 'o', 'f1', 'WEB-9', 'work', 'Which currency?', 'open', NULL, 'dan', 'bob', 1900, 1900, NULL, 'st-todo'),
		('t-quick', 'o', 'q1', 'WEB-11', 'work', 'Fix the typo', 'open', 'sk-build', NULL, 'dan', 900, 900, NULL, 'st-todo'),
		('t-f2work', 'o', 'f2', 'WEB-13', 'work', 'Index', 'done', 'sk-build', NULL, 'bob', 4000, 4000, 4500, 'st-done'),
		('t-f2retro', 'o', 'f2', 'WEB-14', 'retrospective', 'Retrospective: Search', 'open', 'sk-retro', NULL, 'ada', 5000, 5000, NULL, 'st-todo'),
		('t-opsbd', 'o', 'f3', 'OPS-2', 'breakdown', 'Break down: Runbook', 'open', 'sk-breakdown', NULL, 'cat', 1000, 1000, NULL, 'st-todo')`,
	`UPDATE tasks SET claim_id = 'c-held', claim_holder_id = 'bob', claim_session_id = 's-bob', claim_skill_id = 'sk-qa-acme',
		claim_timeout_ms = 60000, claim_expires_at = 99999999999999 WHERE id = 't-held'`,
	`INSERT INTO claims (id, org_id, task_id, holder_id, session_id, skill_id, skill_version, timeout_ms, started_at, ended_at, how_ended, ended_by) VALUES
		('c-bd', 'o', 't-bd', 'bob', 's-bob', 'sk-breakdown', 1, NULL, 1100, 1200, 'completed', 'bob'),
		('c-built', 'o', 't-review', 'bob', 's-bob', 'sk-build', 1, NULL, 1500, 1600, 'handed_over', 'bob'),
		('c-held', 'o', 't-held', 'bob', 's-bob', 'sk-qa-acme', 1, 60000, 1450, NULL, NULL, NULL),
		('c-retro', 'o', 't-f2retro', 'bob', 's-bob', 'sk-retro', 1, NULL, 5100, 5200, 'handed_over', 'bob'),
		('c-sr', 'o', 't-f2retro', 'ada', 's-bob', 'sk-sr', 1, NULL, 5300, 5400, 'released', 'ada')`,
	`INSERT INTO blocks (org_id, task_id, blocker_task_id, added_by, added_at) VALUES ('o', 't-todo', 't-aimed', 'bob', 1900)`,
	`INSERT INTO task_workspaces (org_id, task_id, workspace_id, position) VALUES
		('o', 't-todo', 'ws-web', 1), ('o', 't-held', 'ws-api', 1), ('o', 't-held', 'ws-web', 2), ('o', 't-quick', 'ws-web', 1)`,
	`INSERT INTO evidence (id, org_id, feature_id, task_id, filename, content_type, size, sha256, blob_key, attached_by, created_at) VALUES
		('e-f1', 'o', 'f1', NULL, 'plan.md', 'text/markdown', 1, 'x', 'b1', 'ada', 0),
		('e-q1', 'o', 'q1', NULL, 'shot.png', 'image/png', 1, 'x', 'b2', 'dan', 0),
		('e-todo', 'o', 'f1', 't-todo', 'log.txt', 'text/plain', 1, 'x', 'b3', 'bob', 0)`,
	`INSERT INTO observations (id, org_id, task_id, feature_id, author_id, skill_id, outcome, body, created_at) VALUES
		('o-quick', 'o', 't-quick', 'q1', 'dan', 'sk-build', 'worked', 'small', 0),
		('o-done', 'o', 't-done', 'f1', 'bob', 'sk-build', 'didnt_work', 'slow', 0)`,
	`INSERT INTO views (id, org_id, member_id, entity, team_id, name, filters, sort, display, created_at, updated_at) VALUES
		('v-web', 'o', 'ada', 'tasks', 'tm-web', 'Mine',
			'["status:in:st-todo,st-prog","holder:is:none","team:is:tm-web","feature:is:f1","status_kind:is:todo","kind:is:work"]',
			'rank', '{"layout":"board"}', 0, 0),
		('v-all', 'o', 'ada', 'tasks', NULL, 'Everything', '[]', NULL, NULL, 0, 0),
		('v-features', 'o', 'ada', 'features', 'tm-web', 'Open', '["quick:is:false"]', NULL, NULL, 0, 0)`,
	`INSERT INTO activity (org_id, seq, actor_id, kind, subject_id, payload, at) VALUES
		('o', 1, 'ada', 'feature.filed', 'f1', '{"key":"WEB-1"}', 1000)`,
}

// Migration 0006 moves a database written under 0005 to model v2, keeping every record (the
// steps of docs/build/model-v2-plan.md, "Moving the data").
func TestMigration6MovesTheRecordToModelV2(t *testing.T) {
	for _, e := range storetest.Engines() {
		t.Run(string(e), func(t *testing.T) {
			ctx := t.Context()
			s := storetest.OpenUnmigrated(t, e)
			migrateTo(t, s, 5)
			exec := func(q string, args ...any) error {
				return s.WriteNoSeq(ctx, func(tx store.Tx) error {
					_, err := tx.Exec(ctx, q, args...)
					return err
				})
			}
			for _, q := range v5 {
				if err := exec(q); err != nil {
					t.Fatalf("%s: %v", q, err)
				}
			}
			migrateTo6(t, s)

			strs := func(q string, args ...any) []string {
				t.Helper()
				rows, err := s.Query(ctx, q, args...)
				if err != nil {
					t.Fatalf("%s: %v", q, err)
				}
				defer rows.Close()
				var out []string
				for rows.Next() {
					var v sql.NullString
					if err := rows.Scan(&v); err != nil {
						t.Fatal(err)
					}
					out = append(out, v.String)
				}
				return out
			}
			want := func(what string, got, want []string) {
				t.Helper()
				if !slices.Equal(got, want) {
					t.Errorf("%s:\n got %q\nwant %q", what, got, want)
				}
			}

			// 1. Projects from Teams, ship_when_done as auto_complete; the key counter stands.
			want("projects", strs(`SELECT id || ' ' || key_prefix || ' ' || name || ' ' || CAST(last_number AS TEXT) || ' '
				|| COALESCE(default_workspace_id, '-') || ' ' || CASE WHEN auto_complete THEN 'auto' ELSE 'manual' END
				|| ' ' || CASE WHEN acceptance THEN 'acceptance' ELSE 'none' END FROM projects ORDER BY key_prefix`),
				[]string{"tm-ops OPS Ops 2 - manual none", "tm-web WEB Web 20 ws-web auto none"})
			want("project members", strs(`SELECT project_id || ' ' || member_id FROM project_members ORDER BY project_id, member_id`),
				[]string{"tm-ops cat", "tm-web ada", "tm-web bob"})
			for _, gone := range []string{"teams", "team_members", "features", "statuses"} {
				if err := s.QueryRow(ctx, `SELECT COUNT(*) FROM `+gone).Scan(new(int)); err == nil {
					t.Errorf("table %s is still there", gone)
				}
			}

			// 3. Each Project's Workflow, from the Skills its Tasks needed: a company Skill counts
			// as its generic one, the Backlog hold leads, then breakdown, the others by first use,
			// review, retro and skill-review.
			want("WEB's steps", strs(`SELECT CAST(st.position AS TEXT) || ' ' || st.name || ' ' || COALESCE(sk.name, '(hold)') || ' '
				|| CAST(st.x AS TEXT) || ',' || CAST(st.y AS TEXT)
				FROM steps st LEFT JOIN skills sk ON sk.id = st.skill_id WHERE st.project_id = 'tm-web' ORDER BY st.position`),
				[]string{"1 Backlog (hold) 0,0", "2 Plan breakdown 240,0", "3 Build build 480,0", "4 Qa qa 720,0",
					"5 Review review 960,0", "6 Retro retro 1200,0", "7 Skill review skill-review 1440,0"})
			want("OPS's steps", strs(`SELECT CAST(st.position AS TEXT) || ' ' || st.name || ' ' || sk.name
				FROM steps st JOIN skills sk ON sk.id = st.skill_id WHERE st.project_id = 'tm-ops' ORDER BY st.position`),
				[]string{"1 Plan breakdown"})
			connectors := `SELECT f.name || ' -' || c.name || '-> ' || COALESCE(tt.name, 'Done') || ' ' || CAST(c.position AS TEXT)
				FROM connectors c JOIN steps f ON f.id = c.from_step_id LEFT JOIN steps tt ON tt.id = c.to_step_id
				WHERE c.project_id = $1 AND c.org_id = 'o' ORDER BY f.position, c.position`
			want("WEB's connectors", strs(connectors, "tm-web"), []string{
				"Plan -done-> Done 1",
				"Build -pass-> Qa 1",
				"Qa -pass-> Review 1", "Qa -needs changes-> Build 2",
				"Review -pass-> Done 1", "Review -needs changes-> Build 2",
				"Retro -done-> Done 1", "Retro -propose-> Skill review 2",
				"Skill review -publish-> Done 1", "Skill review -needs changes-> Retro 2",
			})
			want("OPS's connectors", strs(connectors, "tm-ops"), []string{"Plan -done-> Done 1"})
			for _, id := range strs(`SELECT id FROM steps UNION ALL SELECT id FROM connectors`) {
				if u, err := uuid.Parse(id); err != nil || u.Version() != 7 || u.Variant() != uuid.RFC4122 {
					t.Errorf("id %q is not shaped as a UUIDv7 (%v)", id, err)
				}
			}

			// 2 and 4. Features become Tasks, their Tasks Subtasks; a quick Feature's Task stands
			// alone with its Rank, Owner and auto_complete; each open Task is at the Step of its
			// Skill, or Backlog, or none when aimed or ended.
			want("tasks", strs(`SELECT t.display_key || ' ' || t.id || ' ' || t.project_id || ' ' || COALESCE(t.parent_id, '-') || ' '
				|| t.kind || ' ' || t.state || ' ' || COALESCE(st.name, '-') || ' ' || COALESCE(CAST(t.step_since AS TEXT), '-') || ' '
				|| t.owner_id || ' ' || COALESCE(CAST(t.rank AS TEXT), '-') || ' '
				|| CASE WHEN t.breakdown THEN 'B' ELSE 'b' END || CASE WHEN t.auto_complete THEN 'A' ELSE 'a' END
				|| CASE WHEN t.acceptance THEN 'C' ELSE 'c' END || ' ' || COALESCE(t.filed_by, '-') || ' '
				|| COALESCE(t.aimed_at_id, '-') || ' ' || COALESCE(CAST(t.ended_at AS TEXT), '-')
				FROM tasks t LEFT JOIN steps st ON st.id = t.step_id ORDER BY t.project_id, t.display_key`), []string{
				"OPS-1 f3 tm-ops - work open - - cat 1 Bac cat - -",
				"OPS-2 t-opsbd tm-ops f3 breakdown open Plan 1000 cat - bac cat - -",
				"WEB-1 f1 tm-web - work open - - ada 2 BAc ada - -",
				"WEB-11 t-quick tm-web - work open Build 900 dan 1 bAc dan - -",
				"WEB-12 f2 tm-web - work done - - ada 3 bac bob - 5000",
				"WEB-13 t-f2work tm-web f2 work done - - ada - bac bob - 4500",
				"WEB-14 t-f2retro tm-web f2 retrospective open Retro 5000 ada - bac ada - -",
				"WEB-2 t-bd tm-web f1 breakdown done - - ada - bac ada - 1200",
				"WEB-3 t-backlog tm-web f1 work open Backlog 1200 ada - bac bob - -",
				"WEB-4 t-todo tm-web f1 work open Build 1300 ada - bac bob - -",
				"WEB-5 t-held tm-web f1 work open Qa 1400 ada - bac bob - -",
				"WEB-6 t-review tm-web f1 work open Review 1600 ada - bac bob - -",
				"WEB-7 t-done tm-web f1 work done - - ada - bac bob - 1700",
				"WEB-8 t-dropped tm-web f1 work dropped - - ada - bac bob - 1800",
				"WEB-9 t-aimed tm-web f1 work open - - ada - bac bob dan -",
			})
			want("Parents' times", strs(`SELECT id || ' ' || CAST(created_at AS TEXT) || ' ' || CAST(waiting_since AS TEXT) || ' ' || title || '|' || description
				FROM tasks WHERE parent_id IS NULL AND id LIKE 'f%' ORDER BY id`),
				[]string{"f1 1000 1000 Checkout|Pay at the end", "f2 4000 4000 Search|", "f3 1000 1000 Runbook|"})
			want("the held Task's Claim", strs(`SELECT claim_id || ' ' || claim_holder_id || ' ' || claim_session_id || ' ' || claim_skill_id
				|| ' ' || CAST(claim_expires_at AS TEXT) FROM tasks WHERE id = 't-held'`),
				[]string{"c-held bob s-bob sk-qa-acme 99999999999999"})
			if n := len(strs(`SELECT id FROM tasks WHERE id = 'q1' OR display_key = 'WEB-10'`)); n != 0 {
				t.Error("the quick Feature's id or key is still a Task's")
			}
			want("blocks", strs(`SELECT task_id || ' ' || blocker_task_id FROM blocks`), []string{"t-todo t-aimed"})
			want("Workspaces", strs(`SELECT task_id || ' ' || workspace_id || ' ' || CAST(position AS TEXT) FROM task_workspaces
				ORDER BY task_id, position`),
				[]string{"f1 ws-web 1", "f1 ws-api 2", "t-held ws-api 1", "t-held ws-web 2", "t-quick ws-web 1", "t-todo ws-web 1"})

			// 5. Evidence on a Feature moves to the Task it became, or to a quick Feature's one Task.
			want("Evidence", strs(`SELECT id || ' ' || task_id FROM evidence ORDER BY id`),
				[]string{"e-f1 f1", "e-q1 t-quick", "e-todo t-todo"})
			want("Observations", strs(`SELECT id || ' ' || task_id FROM observations ORDER BY id`),
				[]string{"o-done t-done", "o-quick t-quick"})
			for _, col := range []string{"evidence.feature_id", "observations.feature_id", "tasks.feature_id", "tasks.status_id",
				"tasks.skill_id", "views.team_id"} {
				table, column, _ := strings.Cut(col, ".")
				if err := s.QueryRow(ctx, `SELECT COUNT(`+column+`) FROM `+table).Scan(new(int)); err == nil {
					t.Errorf("column %s is still there", col)
				}
			}

			// Views: of the Tasks list only, status tokens gone, team and feature tokens renamed.
			views := map[string][2]string{}
			rows, err := s.Query(ctx, `SELECT id, COALESCE(project_id, '-'), filters FROM views ORDER BY id`)
			if err != nil {
				t.Fatal(err)
			}
			for rows.Next() {
				var id, project, filters string
				if err := rows.Scan(&id, &project, &filters); err != nil {
					t.Fatal(err)
				}
				var tokens []string
				if err := json.Unmarshal([]byte(filters), &tokens); err != nil {
					t.Fatalf("View %s's filters %q: %v", id, filters, err)
				}
				views[id] = [2]string{project, strings.Join(tokens, " ")}
			}
			rows.Close()
			if fmt.Sprint(views) != fmt.Sprint(map[string][2]string{
				"v-all": {"-", ""},
				"v-web": {"tm-web", "holder:is:none project:is:tm-web parent:is:f1 kind:is:work"},
			}) {
				t.Errorf("Views %v", views)
			}

			// 6. The checks: kind takes acceptance, a Claim ends advanced or split, a View is of
			// the Tasks list; what went is refused.
			want("Claims", strs(`SELECT id || ' ' || COALESCE(how_ended, 'live') FROM claims ORDER BY id`),
				[]string{"c-bd completed", "c-built advanced", "c-held live", "c-retro advanced", "c-sr released"})
			for _, q := range []string{
				`UPDATE tasks SET kind = 'acceptance' WHERE id = 't-todo'`,
				`UPDATE claims SET how_ended = 'split' WHERE id = 'c-bd'`,
				`UPDATE claims SET how_ended = 'advanced' WHERE id = 'c-bd'`,
			} {
				if err := exec(q); err != nil {
					t.Errorf("%s: %v", q, err)
				}
			}
			for _, q := range []string{
				`UPDATE tasks SET kind = 'feature' WHERE id = 't-todo'`,
				`UPDATE claims SET how_ended = 'handed_over' WHERE id = 'c-bd'`,
				`INSERT INTO views (id, org_id, member_id, entity, name, filters, created_at, updated_at) VALUES ('v9', 'o', 'ada', 'features', 'x', '[]', 0, 0)`,
				`UPDATE tasks SET owner_id = NULL WHERE id = 't-todo'`,
				`UPDATE tasks SET project_id = 'nope' WHERE id = 't-todo'`,
				`UPDATE tasks SET step_id = 'nope' WHERE id = 't-todo'`,
				`UPDATE evidence SET task_id = NULL WHERE id = 'e-f1'`,
				`INSERT INTO steps (id, org_id, project_id, name, position, x, y, created_at) VALUES ('st-x', 'o', 'tm-web', 'Plan', 9, 0, 0, 0)`,
				`INSERT INTO task_labels (org_id, task_id, label_id) VALUES ('o', 't-todo', 'nope')`,
			} {
				if err := exec(q); err == nil {
					t.Errorf("accepted: %s", q)
				}
			}

			// acceptance is the fourth builtin generic Skill, at version 1.
			want("acceptance", strs(`SELECT sk.kind || ' ' || CASE WHEN sk.builtin THEN 'builtin' ELSE 'own' END || ' '
				|| CAST(sk.current_version AS TEXT) || ' ' || CAST(v.version AS TEXT)
				FROM skills sk JOIN skill_versions v ON v.skill_id = sk.id WHERE sk.name = 'acceptance'`),
				[]string{"generic builtin 1 1"})
			for _, id := range strs(`SELECT id FROM skills WHERE name = 'acceptance'`) {
				if u, err := uuid.Parse(id); err != nil || u.Version() != 7 {
					t.Errorf("the acceptance Skill's id %q is not shaped as a UUIDv7 (%v)", id, err)
				}
			}

			// Activity is the trail of what happened and is left as it was written.
			want("Activity", strs(`SELECT CAST(seq AS TEXT) || ' ' || kind || ' ' || subject_id FROM activity`), []string{"1 feature.filed f1"})

			// The new tables take rows under their checks.
			for _, q := range []string{
				`INSERT INTO labels (id, org_id, project_id, name, color, created_at) VALUES ('l-web', 'o', 'tm-web', 'bug', '#ff0000', 0)`,
				`INSERT INTO labels (id, org_id, project_id, name, color, created_at) VALUES ('l-org', 'o', NULL, 'client', '#00ff00', 0)`,
				`INSERT INTO task_labels (org_id, task_id, label_id) VALUES ('o', 't-todo', 'l-web'), ('o', 'f1', 'l-org')`,
				`UPDATE tasks SET parent_id = 'f1' WHERE id = 't-quick'`,
			} {
				if err := exec(q); err != nil {
					t.Errorf("%s: %v", q, err)
				}
			}
		})
	}
}

// SQLite migrates with foreign keys off, and the connection it used enforces them again after.
func TestMigratingLeavesForeignKeysEnforced(t *testing.T) {
	ctx := t.Context()
	s := storetest.OpenUnmigrated(t, store.SQLite, store.WithMaxConns(1))
	migrateTo(t, s, 5)
	migrateTo6(t, s)
	err := s.WriteNoSeq(ctx, func(tx store.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO members (id, org_id, name, kind, created_at, updated_at) VALUES ('m', 'nope', 'm', 'human', 0, 0)`)
		return err
	})
	if err == nil {
		t.Fatal("a Member of no Organisation was accepted after migrating")
	}
}
