package core_test

import (
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// filterKeys lists the display keys of the Tasks tf finds, sorted.
func (f *fixture) filterKeys(tf core.TaskFilter) []string {
	f.t.Helper()
	tf.Limit = 500
	p, err := f.svc.ListTasks(f.t.Context(), f.admin, tf)
	if err != nil {
		f.t.Fatalf("%q: %v", tf.Filters, err)
	}
	keys := make([]string, len(p.Items))
	for i, t := range p.Items {
		keys[i] = t.Key
	}
	slices.Sort(keys)
	return keys
}

func sortedKeys(ks ...string) []string {
	slices.Sort(ks)
	if ks == nil {
		return []string{}
	}
	return ks
}

// Every Task field of the filter grammar, with at least one operator each, on both engines:
// refs by id, words, booleans, numbers, dates given with offsets and milliseconds and as `last`,
// holder:is:none, parent:is:none, q over key and title, and negations that keep the Tasks with no
// value for the field. Several tokens AND, and they compose with ListTasks' other parameters.
func TestTaskFilters(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		web, ops := f.project("WEB"), f.project("OPS")
		f.chainBuildIntoDone("WEB")
		engineer := f.skillID(core.SkillEngineer)
		ada := f.admin
		if err := f.svc.AddProjectMember(ctx, ada, "WEB", ada.MemberID, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if err := f.svc.GrantSkill(ctx, ada, ada.MemberID, core.SkillEngineer, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		builder := f.member("builder", []string{"WEB"}, []string{core.SkillEngineer})
		lead := f.member("lead", []string{"WEB"}, nil)
		opsy := f.member("opsy", []string{"OPS"}, []string{core.SkillEngineer})
		ws := f.workspace("web")
		bug, err := f.svc.CreateLabel(ctx, lead, core.NewLabel{Project: ptrStr("WEB"), Name: "bug", Color: "#ff0000"}, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		client, err := f.svc.CreateLabel(ctx, ada, core.NewLabel{Name: "client", Color: "#00ff00"}, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		build, backlog := f.step("WEB", "Build"), f.step("WEB", "Backlog")

		// 09:00Z: Checkout (WEB-1, its Breakdown WEB-2) and the cart page, in a Workspace.
		checkout := f.fileTask(lead, core.NewTask{Project: ptrStr("WEB"), Title: "Checkout", Breakdown: true, Acceptance: ptrBool(true)}).Task.ID
		cart := f.fileTask(lead, core.NewTask{Parent: &checkout, Title: "Cart page: totals, with 100% of the tax_rate",
			Step: ptrStr("Build"), Description: "Uses Stripe", Workspaces: &[]string{ws.ID}, Labels: []string{bug.ID}})
		// 10:00Z: four more, one into the Backlog.
		f.clock.Advance(time.Hour)
		copyTask := f.subtask(lead, checkout, "Checkout copy", "Build")
		later := f.subtask(lead, checkout, "Later", "Backlog")
		fix := f.subtask(lead, checkout, "Old fix", "Build")
		gone := f.subtask(lead, checkout, "Gone", "Build")
		// 11:00Z: a Task standing alone; Billing (OPS-1, OPS-2) and its invoice; the claims; a
		// question; one Task done, one dropped.
		f.clock.Advance(time.Hour)
		alone := f.fileTask(lead, core.NewTask{Project: ptrStr("WEB"), Title: "Standalone", Step: ptrStr("Build"), Labels: []string{client.ID}}).Task
		billing := f.fileTask(opsy, core.NewTask{Project: ptrStr("OPS"), Title: "Billing", Breakdown: true, AutoComplete: ptrBool(true)}).Task.ID
		invoice := f.subtask(opsy, billing, "Invoice PDF", "Build")
		f.claim(builder, cart.Task.Key, core.ClaimOptions{Timeout: ptrDur(time.Hour), ModelLabel: ptrStr("opus-5:fast")})
		f.claim(ada, copyTask.Key, noTimeout)
		question, err := f.svc.FileTask(ctx, ada, core.NewTask{Blocks: &copyTask.Key, Title: "Which wording?", AimedAt: &lead.MemberID}, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		f.claim(ada, fix.Key, noTimeout)
		f.complete(ada, fix.Key)
		if _, err := f.svc.DropTask(ctx, lead, gone.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		f.claim(opsy, invoice.Key, timeout(time.Minute))
		// 11:02Z: the invoice's Claim has lapsed, nobody has recorded it, and the cart has a Note.
		f.clock.Advance(2 * time.Minute)
		if _, err := f.svc.AddNote(ctx, builder, cart.Task.Key, "half done", core.Idem{}); err != nil {
			t.Fatal(err)
		}
		want := map[string]string{"cart": cart.Task.Key, "copy": copyTask.Key, "later": later.Key, "fix": fix.Key,
			"gone": gone.Key, "question": question.Task.Key, "alone": alone.Key, "invoice": invoice.Key}
		if fmt.Sprint(want) != "map[alone:WEB-8 cart:WEB-3 copy:WEB-4 fix:WEB-6 gone:WEB-7 invoice:OPS-3 later:WEB-5 question:WEB-9]" {
			t.Fatalf("keys %v", want)
		}
		all := sortedKeys("WEB-1", "WEB-2", "WEB-3", "WEB-4", "WEB-5", "WEB-6", "WEB-7", "WEB-8", "WEB-9", "OPS-1", "OPS-2", "OPS-3")
		except := func(out ...string) []string {
			return slices.DeleteFunc(slices.Clone(all), func(k string) bool { return slices.Contains(out, k) })
		}
		unheld := except("WEB-3", "WEB-4")
		checkoutSubs := sortedKeys("WEB-2", "WEB-3", "WEB-4", "WEB-5", "WEB-6", "WEB-7", "WEB-9")

		for _, c := range []struct {
			filters []string
			want    []string
		}{
			{nil, all},
			{[]string{"step:is:" + build}, sortedKeys("WEB-3", "WEB-4", "WEB-8")},
			{[]string{"step:in:" + build + "," + backlog}, sortedKeys("WEB-3", "WEB-4", "WEB-5", "WEB-8")},
			{[]string{"step:nin:" + build}, except("WEB-3", "WEB-4", "WEB-8")},
			{[]string{"step:is:" + "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"}, sortedKeys()}, // an id that names nothing
			{[]string{"skill:is:" + engineer}, sortedKeys("WEB-3", "WEB-4", "WEB-8", "OPS-3")},
			// The Parents, the question, the hold and the ended Tasks are at no Step carrying it.
			{[]string{"skill:not:" + engineer}, except("WEB-3", "WEB-4", "WEB-8", "OPS-3")},
			{[]string{"label:is:" + bug.ID}, sortedKeys("WEB-3")},
			{[]string{"label:in:" + bug.ID + "," + client.ID}, sortedKeys("WEB-3", "WEB-8")},
			{[]string{"label:nin:" + bug.ID}, except("WEB-3")},
			{[]string{"parent:is:" + checkout}, checkoutSubs},
			{[]string{"parent:is:none"}, sortedKeys("WEB-1", "WEB-8", "OPS-1")},
			{[]string{"parent:in:none," + billing}, sortedKeys("WEB-1", "WEB-8", "OPS-1", "OPS-2", "OPS-3")},
			{[]string{"parent:not:none"}, except("WEB-1", "WEB-8", "OPS-1")},
			{[]string{"top:is:true"}, sortedKeys("WEB-1", "WEB-8", "OPS-1")},
			{[]string{"top:is:false"}, except("WEB-1", "WEB-8", "OPS-1")},
			{[]string{"holder:is:none"}, unheld},
			{[]string{"holder:is:" + ada.MemberID}, sortedKeys("WEB-4")},
			{[]string{"holder:in:none," + builder.MemberID}, except("WEB-4")},
			{[]string{"holder:nin:none"}, sortedKeys("WEB-3", "WEB-4")},
			{[]string{"holder:is:" + opsy.MemberID}, sortedKeys()}, // lapsed
			{[]string{"aimed_at:is:" + lead.MemberID}, sortedKeys("WEB-9")},
			{[]string{"aimed_at:not:" + lead.MemberID}, except("WEB-9")},
			{[]string{"owner:is:" + opsy.MemberID}, sortedKeys("OPS-1", "OPS-2", "OPS-3")},
			{[]string{"owner:not:" + opsy.MemberID}, except("OPS-1", "OPS-2", "OPS-3")},
			{[]string{"project:in:" + web}, except("OPS-1", "OPS-2", "OPS-3")},
			{[]string{"project:nin:" + web + "," + ops}, sortedKeys()},
			{[]string{"filed_by:is:" + ada.MemberID}, sortedKeys("WEB-9")},
			// Darkory filed the Breakdowns: no one filed them, so they are not the lead's.
			{[]string{"filed_by:not:" + lead.MemberID}, sortedKeys("WEB-2", "WEB-9", "OPS-1", "OPS-2", "OPS-3")},
			{[]string{"blocked:is:true"}, sortedKeys("WEB-4")},
			{[]string{"blocked:is:false"}, except("WEB-4")},
			{[]string{"blocked:in:true,false"}, all},
			{[]string{"blocks:is:true"}, sortedKeys("WEB-9")},
			{[]string{"blocks:not:true"}, except("WEB-9")},
			{[]string{"kind:is:question"}, sortedKeys("WEB-9")},
			{[]string{"kind:is:breakdown"}, sortedKeys("WEB-2", "OPS-2")},
			{[]string{"kind:is:acceptance"}, sortedKeys()},
			{[]string{"kind:is:work"}, except("WEB-2", "WEB-9", "OPS-2")},
			{[]string{"kind:in:retrospective,question"}, sortedKeys("WEB-9")},
			{[]string{"kind:nin:work,breakdown"}, sortedKeys("WEB-9")},
			{[]string{"claim:is:held"}, sortedKeys("WEB-3", "WEB-4")},
			{[]string{"claim:is:unheld"}, unheld},
			// No Runner runs a session here (TaskFilter.SessionTasks is empty).
			{[]string{"claim:is:session"}, sortedKeys()},
			{[]string{"claim:not:session"}, all},
			{[]string{"claim:is:lapsed"}, sortedKeys("OPS-3")},
			{[]string{"claim:in:held,lapsed"}, sortedKeys("WEB-3", "WEB-4", "OPS-3")},
			// Agents with engineer in WEB (builder) and OPS (opsy); a human with it in WEB (ada).
			{[]string{"takeable_by:is:agents"}, sortedKeys("WEB-3", "WEB-4", "WEB-8", "OPS-3")},
			{[]string{"takeable_by:is:humans"}, sortedKeys("WEB-3", "WEB-4", "WEB-8")},
			{[]string{"takeable_by:is:both"}, sortedKeys("WEB-3", "WEB-4", "WEB-8")},
			{[]string{"takeable_by:not:agents"}, except("WEB-3", "WEB-4", "WEB-8", "OPS-3")},
			// A Subtask has its Parent's Rank.
			{[]string{"rank:is:1"}, except("WEB-8")},
			{[]string{"rank:is:2"}, sortedKeys("WEB-8")},
			{[]string{"rank:gte:2"}, sortedKeys("WEB-8")},
			{[]string{"rank:lte:1", "project:is:" + web}, except("WEB-8", "OPS-1", "OPS-2", "OPS-3")},
			{[]string{"rank:nin:1"}, sortedKeys("WEB-8")},
			{[]string{"auto_complete:is:true"}, sortedKeys("OPS-1")},
			{[]string{"acceptance:is:true"}, sortedKeys("WEB-1")},
			{[]string{"acceptance:not:true", "top:is:true"}, sortedKeys("WEB-8", "OPS-1")},
			{[]string{"workspace:is:" + ws.ID}, sortedKeys("WEB-3")},
			{[]string{"workspace:not:" + ws.ID}, except("WEB-3")},
			{[]string{"model:is:opus-5%3Afast"}, sortedKeys("WEB-3")},
			{[]string{"model:not:opus-5%3Afast"}, except("WEB-3")},
			{[]string{"model:is:opus-5"}, sortedKeys()},
			{[]string{"filed_at:before:2026-10-06T10:00:00Z"}, sortedKeys("WEB-1", "WEB-2", "WEB-3")},
			// The same instant at +11:00, its + and colons percent-encoded, or the colons left bare.
			{[]string{"filed_at:before:2026-10-06T21%3A00%3A00%2B11%3A00"}, sortedKeys("WEB-1", "WEB-2", "WEB-3")},
			{[]string{"filed_at:before:2026-10-06T21:00:00%2B11:00"}, sortedKeys("WEB-1", "WEB-2", "WEB-3")},
			{[]string{"filed_at:before:2026-10-06T05:00:00-05:00"}, sortedKeys("WEB-1", "WEB-2", "WEB-3")},
			{[]string{"filed_at:after:2026-10-06T10:30:00Z"}, sortedKeys("WEB-8", "WEB-9", "OPS-1", "OPS-2", "OPS-3")},
			{[]string{"filed_at:gte:2026-10-06T10:00:00Z"}, except("WEB-1", "WEB-2", "WEB-3")},
			{[]string{"filed_at:lte:2026-10-06T10:00:00Z"}, sortedKeys("WEB-1", "WEB-2", "WEB-3", "WEB-4", "WEB-5", "WEB-6", "WEB-7")},
			{[]string{"filed_at:btw:2026-10-06T09:30:00Z,2026-10-06T10:00:00Z"}, sortedKeys("WEB-4", "WEB-5", "WEB-6", "WEB-7")},
			// Milliseconds, and a day picked in the browser at +11:00 sent as its local bounds.
			{[]string{"filed_at:lte:2026-10-06T09:59:59.999Z"}, sortedKeys("WEB-1", "WEB-2", "WEB-3")},
			{[]string{"filed_at:btw:2026-10-06T20:00:00.000%2B11:00,2026-10-06T21:00:00.000%2B11:00"}, except("WEB-8", "WEB-9", "OPS-1", "OPS-2", "OPS-3")},
			{[]string{"filed_at:btw:2026-10-06T00:00:00.000%2B11:00,2026-10-06T23:59:59.999%2B11:00"}, all},
			{[]string{"filed_at:btw:2026-10-07T00:00:00.000%2B11:00,2026-10-07T23:59:59.999%2B11:00"}, sortedKeys()},
			{[]string{"filed_at:last:7d"}, all},
			{[]string{"completed_at:gte:2026-10-06T00:00:00Z"}, sortedKeys("WEB-6")},
			{[]string{"completed_at:last:7d"}, sortedKeys("WEB-6")},
			// Ended done or dropped.
			{[]string{"ended_at:gte:2026-10-06T00:00:00Z"}, sortedKeys("WEB-6", "WEB-7")},
			{[]string{"ended_at:last:7d"}, sortedKeys("WEB-6", "WEB-7")},
			{[]string{"q:contains:cart"}, sortedKeys("WEB-3")},
			{[]string{"q:contains:CART%20PAGE"}, sortedKeys("WEB-3")},
			{[]string{"q:contains:ops-3"}, sortedKeys("OPS-3")},
			{[]string{"q:contains:totals%2C%20with"}, sortedKeys("WEB-3")},
			// Not the description.
			{[]string{"q:contains:stripe"}, sortedKeys()},
			// LIKE's wildcards in a value match themselves.
			{[]string{"q:contains:100%25"}, sortedKeys("WEB-3")},
			{[]string{"q:contains:_"}, sortedKeys("WEB-3")},
			{[]string{"q:contains:%25"}, sortedKeys("WEB-3")},
			{[]string{"q:contains:nothing%20like%20it"}, sortedKeys()},
			{[]string{"skill:is:" + engineer, "holder:is:none"}, sortedKeys("WEB-8", "OPS-3")},
			{[]string{"project:is:" + web, "claim:is:unheld", "top:is:false"}, sortedKeys("WEB-2", "WEB-5", "WEB-6", "WEB-7", "WEB-9")},
		} {
			if got := f.filterKeys(core.TaskFilter{Filters: c.filters}); !slices.Equal(got, c.want) {
				t.Errorf("%q: %v, want %v", c.filters, got, c.want)
			}
		}

		// The other parameters compose with the filter.
		if got := f.filterKeys(core.TaskFilter{Project: ptrStr("OPS"), Filters: []string{"claim:is:lapsed"}}); !slices.Equal(got, sortedKeys("OPS-3")) {
			t.Errorf("OPS and lapsed: %v", got)
		}
		if got := f.filterKeys(core.TaskFilter{Project: ptrStr("WEB"), Filters: []string{"claim:is:lapsed"}}); len(got) != 0 {
			t.Errorf("WEB and lapsed: %v", got)
		}
		if got := f.filterKeys(core.TaskFilter{Project: ptrStr("WEB"), Step: ptrStr("backlog")}); !slices.Equal(got, sortedKeys("WEB-5")) {
			t.Errorf("WEB at Backlog: %v", got)
		}
		if got := f.filterKeys(core.TaskFilter{Parent: &checkout, Filters: []string{"skill:is:" + engineer}}); !slices.Equal(got, sortedKeys("WEB-3", "WEB-4")) {
			t.Errorf("Checkout's at an engineer Step: %v", got)
		}
		// A Step by its id needs no Project; by its name it does.
		if got := f.filterKeys(core.TaskFilter{Step: &backlog}); !slices.Equal(got, sortedKeys("WEB-5")) {
			t.Errorf("at Backlog by its id: %v", got)
		}
		_, err = f.svc.ListTasks(ctx, f.admin, core.TaskFilter{Step: ptrStr("Backlog")})
		wantCode(t, err, core.CodeInvalid)
		// claim:is:session matches the Tasks the server's Runner says it runs a session for.
		session := core.TaskFilter{Filters: []string{"claim:is:session"}, SessionTasks: []string{cart.Task.ID, invoice.ID}}
		if got := f.filterKeys(session); !slices.Equal(got, sortedKeys("WEB-3", "OPS-3")) {
			t.Errorf("in a session: %v", got)
		}
		session.Filters = []string{"claim:nin:session,held"}
		if got := f.filterKeys(session); !slices.Equal(got, except("WEB-3", "WEB-4", "OPS-3")) {
			t.Errorf("in no session and unheld: %v", got)
		}
		if got := f.filterKeys(core.TaskFilter{State: ptrStr("open"), Holder: ptrStr("builder"), Filters: []string{"blocked:is:false"}}); !slices.Equal(got, sortedKeys("WEB-3")) {
			t.Errorf("held by the builder, open, not blocked: %v", got)
		}

		// A recorded lapse is a lapse too, and stays one for 24 hours whatever comes after.
		if n, err := f.svc.Sweep(ctx); err != nil || n != 1 {
			t.Fatalf("sweep: %d %v", n, err)
		}
		lapsed := core.TaskFilter{Filters: []string{"claim:is:lapsed"}}
		if got := f.filterKeys(lapsed); !slices.Equal(got, sortedKeys("OPS-3")) {
			t.Errorf("after the sweep: %v", got)
		}
		// 23 hours on, the cart's hour-long Claim has lapsed too, unrecorded.
		f.clock.Advance(23 * time.Hour)
		if got := f.filterKeys(lapsed); !slices.Equal(got, sortedKeys("OPS-3", "WEB-3")) {
			t.Errorf("23 hours on: %v", got)
		}
		f.claim(opsy, invoice.Key, noTimeout)
		if got := f.filterKeys(lapsed); !slices.Equal(got, sortedKeys("OPS-3", "WEB-3")) {
			t.Errorf("claimed again: %v", got)
		}
		if _, err := f.svc.Release(ctx, opsy, invoice.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if got := f.filterKeys(lapsed); !slices.Equal(got, sortedKeys("OPS-3", "WEB-3")) {
			t.Errorf("claimed again and released: %v", got)
		}

		// A day later both lapses are more than 24 hours old: neither held nor lapsed.
		f.clock.Advance(26 * time.Hour)
		if got := f.filterKeys(core.TaskFilter{Filters: []string{"claim:in:held,lapsed,session"}}); !slices.Equal(got, sortedKeys("WEB-4")) {
			t.Errorf("a day on: %v", got)
		}
		// Eight days on, nothing was filed in the last 7 days; all of it in the last 30.
		f.clock.Advance(6 * 24 * time.Hour)
		if got := f.filterKeys(core.TaskFilter{Filters: []string{"filed_at:last:7d"}}); len(got) != 0 {
			t.Errorf("filed in the last 7 days, 8 days on: %v", got)
		}
		if got := f.filterKeys(core.TaskFilter{Filters: []string{"filed_at:last:30d"}}); !slices.Equal(got, all) {
			t.Errorf("filed in the last 30 days: %v", got)
		}
	})
}

// A token the grammar refuses is invalid, and the refusal quotes it; a refused token never runs.
func TestFiltersRefused(t *testing.T) {
	f := newFixture(t, storetest.Open(t, store.SQLite))
	ctx := t.Context()
	id := "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
	many := make([]string, 101)
	for i := range many {
		many[i] = id
	}
	for _, tok := range []string{
		"",
		"statuz:is:" + id,
		"status",
		"status:is",
		"status:is:",
		"status:contains:" + id,
		"status:is:" + id + "," + id,
		"status:is:Todo",
		"status:in:" + id + ",",
		"status_kind:is:doing",
		"holder:is:nobody",
		"blocked:is:yes",
		"blocked:btw:true,false",
		"kind:is:retro",
		"claim:is:lapsed_24h",
		"claim:is:live_session",
		"updated_at:last:7d",
		"filed_at:before:2026-10-06",
		"filed_at:before:2026-10-06T10:00:00",
		"filed_at:before:yesterday",
		"filed_at:is:2026-10-06T10:00:00Z",
		"filed_at:btw:2026-10-06T10:00:00Z",
		"filed_at:btw:2026-10-06T11:00:00Z,2026-10-06T10:00:00Z",
		"filed_at:last:14d",
		"filed_at:last:7d,30d",
		"q:is:cart",
		"q:contains:a,b",
		"q:contains:%zz",
		"model:is:" + strings.Repeat("x", 201),
		"skill:in:" + strings.Join(many, ","),
		"quick:is:true",
		// The fields model v2 removed.
		"team:is:" + id,
		"feature:is:" + id,
		"ship_when_done:is:true",
		// And the new ones refuse what they do not take.
		"step:is:Build",
		"parent:is:Checkout",
		"label:is:bug",
		"top:is:maybe",
		"rank:is:0",
		"rank:is:first",
		"rank:is:01",
		"rank:btw:1,2",
		"takeable_by:is:robots",
		"kind:is:feature",
	} {
		_, err := f.svc.ListTasks(ctx, f.admin, core.TaskFilter{Filters: []string{tok}})
		wantCode(t, err, core.CodeInvalid)
		if !strings.Contains(err.Error(), fmt.Sprintf("%q", tok)) {
			t.Errorf("%q: the refusal does not quote the token: %v", tok, err)
		}
	}
	// One bad token among good ones refuses the list.
	_, err := f.svc.ListTasks(ctx, f.admin, core.TaskFilter{Filters: []string{"holder:is:none", "blocked:is:maybe"}})
	wantCode(t, err, core.CodeInvalid)
	tooMany := make([]string, 51)
	for i := range tooMany {
		tooMany[i] = "holder:is:none"
	}
	_, err = f.svc.ListTasks(ctx, f.admin, core.TaskFilter{Filters: tooMany})
	wantCode(t, err, core.CodeInvalid)
	if _, err := f.svc.ListTasks(ctx, f.admin, core.TaskFilter{Filters: tooMany[:50]}); err != nil {
		t.Errorf("50 filters: %v", err)
	}
}
