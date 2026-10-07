package e2e

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/tools/bots/bot"
)

// The accounting preset at work on a fresh Install: the planner, the drafter, reviewer-tax and
// retro as its agents, and Mai Tran and Kai Nguyen as the human personas the bots run, each with a
// token of their own. As they work, the test checks that:
//
//   - Setup is idempotent: run again, it changes nothing but the tokens. The Statuses are the
//     accounting list, two of the backlog kind, and the clients Workspace is a git repository,
//     BOOK's and TAX's default.
//   - A Task in Backlog, the intake, is never offered by next: while Kai is away, Reconcile bank
//     feed, its blocker ended, and the fixed asset register wait there untaken and are not
//     takeable; once Kai is back he moves them to Todo and the drafter takes each after its move.
//   - The drafter's question about March's statements is aimed at Mai, blocks Collect bank
//     statements, and only Mai takes it. She moves Collect, which the drafter holds, to Awaiting
//     client on seeing the question and back to Todo once she has the answer, before completing
//     the question; then Collect completes, which unblocks Reconcile. Kai never moves a Task out
//     of Awaiting client, and no Claim begins on a Task there.
//   - Draft the BAS is handed over to tax-review, landing In review, and reviewer-tax completes it.
//   - The quick Feature ships in the write that completes its one Task's review.
//   - Q1 BAS ships itself (ship when done) in the write in which Mai completes Lodge the BAS.
//
// Then, with the bots stopped and their tokens revoked, every Task's Status agrees with its state
// and last Claim and with a replay of its Activity, and the workpapers the bots wrote are in the
// Workspace's repository.
func TestBotsAccounting(t *testing.T) {
	in := newInstall(t)
	url := in.servers[0].url
	ctx := t.Context()
	admin := dialAs(t, url, in.ada)
	root := filepath.Join(in.dir, "bots")
	opts := bot.Options{Preset: &bot.Accounting, Personas: true, WorkspaceRoot: root, Timeout: bot.Fast.Timeout, TokenName: "bots"}
	first, err := bot.Setup(ctx, admin.c, opts)
	if err != nil {
		t.Fatal(err)
	}
	shape := orgShape(admin)
	if err := first.Revoke(ctx, admin.c); err != nil {
		t.Fatal(err)
	}
	crew, err := bot.Setup(ctx, admin.c, opts)
	if err != nil {
		t.Fatal(err)
	}
	if again := orgShape(admin); !reflect.DeepEqual(shape, again) {
		t.Fatalf("a second Setup changed the Organisation:\n%s\nthen\n%s", strings.Join(shape, "\n"), strings.Join(again, "\n"))
	}
	id := func(name string) string { return crew.Members[name].ID }
	mai, kai := id(bot.PersonaMai), id(bot.PersonaKai)

	// The Statuses are the accounting list, in order, and the Teams work in the clients repository.
	statuses := admin.statuses()
	var got []string
	status := map[string]client.Status{}
	for _, s := range statuses {
		got = append(got, s.Name+" "+string(s.Kind))
		status[s.Name] = s
	}
	var want []string
	for _, s := range bot.Accounting.Statuses {
		want = append(want, s.Name+" "+string(s.Kind))
	}
	if !slices.Equal(got, want) {
		t.Fatalf("the Statuses are %v, want %v", got, want)
	}
	backlog, awaiting, todo, inReview := status[bot.StatusBacklog], status[bot.StatusAwaitingClient], status["Todo"], status["In review"]
	inProgress := status["In progress"]
	ws := crew.Workspaces[bot.WorkspaceClients]
	repo := filepath.Join(root, bot.WorkspaceClients)
	if ws.Path != repo || ws.Kind != client.WorkspaceKindGit {
		t.Fatalf("the clients Workspace is %+v, want a git Workspace at %s", ws, repo)
	}
	if _, err := os.Stat(filepath.Join(repo, ".git")); err != nil {
		t.Fatalf("the clients Workspace is not a repository: %v", err)
	}
	for _, key := range []string{"BOOK", "TAX"} {
		res, err := admin.c.GetTeamWithResponse(ctx, key)
		if err != nil || res.JSON200 == nil {
			t.Fatalf("reading %s: %v %s", key, err, bodyOf(res))
		}
		tm := res.JSON200.Team
		if tm.DefaultWorkspaceID == nil || *tm.DefaultWorkspaceID != ws.ID || tm.ShipWhenDone != (key == "BOOK") {
			t.Fatalf("Team %s is %+v", key, tm)
		}
	}
	// The drafter collects too: no agent of the brief's roster had client-comms, which only Mai
	// had, and she is who its question is aimed at (decisions.md).
	for _, s := range bot.Accounting.Agents {
		res, err := admin.c.GetMemberWithResponse(ctx, s.Name)
		if err != nil || res.JSON200 == nil {
			t.Fatalf("reading %s: %v %s", s.Name, err, bodyOf(res))
		}
		m := res.JSON200
		var skills []string
		for _, sk := range m.Skills {
			skills = append(skills, sk.Name)
		}
		slices.Sort(skills)
		wantSkills := slices.Sorted(slices.Values(s.Skills))
		if m.Member.Kind != client.Agent || m.Member.ManagerID == nil || *m.Member.ManagerID != kai || !slices.Equal(skills, wantSkills) {
			t.Fatalf("%s is %+v with Skills %v, want %v", s.Name, m.Member, skills, wantSkills)
		}
	}

	// The bots start, Kai held back so what waits in Backlog stays there for a while. A watcher
	// looks for Tasks held while in a backlog Status: never in Backlog, and in Awaiting client only
	// under a Claim that began before the Task was moved there (checked against the trail below).
	rec := &botLog{t: t}
	cfg := bot.Config{URL: url, Pace: bot.Fast, Report: rec.add}
	runCtx, stopRunning := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	var mu sync.Mutex
	ended := map[string]error{}
	start := func(b bot.Bot) {
		wg.Go(func() {
			err := b.Run(runCtx)
			mu.Lock()
			ended[b.Name()] = err
			mu.Unlock()
		})
	}
	var kaiBot bot.Bot
	for _, b := range crew.Bots(cfg) {
		if b.Name() == bot.PersonaKai {
			kaiBot = b
			continue
		}
		start(b)
	}
	var heldBacklog []string
	heldAwaiting := map[string]client.Task{} // by Claim id
	polls := 0
	wg.Go(func() {
		for sleepCtx(runCtx, 100*time.Millisecond) {
			for _, s := range []client.Status{backlog, awaiting} {
				res, err := admin.c.ListTasksWithResponse(runCtx, &client.ListTasksParams{Status: &s.Name, Limit: ptr(500)})
				if err != nil || res.JSON200 == nil {
					continue
				}
				mu.Lock()
				polls++
				for _, tk := range res.JSON200.Items {
					switch {
					case tk.Claim == nil:
					case s.ID == backlog.ID:
						heldBacklog = append(heldBacklog, tk.Key+" held by "+tk.Claim.HolderID)
					default:
						heldAwaiting[tk.Claim.ID] = tk
					}
				}
				mu.Unlock()
			}
		}
	})
	stopBots := sync.OnceFunc(func() {
		stopRunning()
		wg.Wait()
	})
	t.Cleanup(stopBots)

	// The admin files three of the preset's Features for Kai, the partner.
	file := func(title string) client.FeatureDetail {
		tmpl := bot.Accounting.Template(title)
		if tmpl == nil {
			t.Fatalf("the preset has no Feature %q", title)
		}
		d, err := crew.File(ctx, admin.c, *tmpl, "")
		if err != nil {
			t.Fatal(err)
		}
		if d.Feature.OwnerID != kai || d.Feature.Description == "" {
			t.Fatalf("filed %+v", d.Feature)
		}
		return *d
	}
	bas := file("Q1 BAS — Northwind Traders")
	quick := file("Fix the GST code on invoice 1042")
	fy := file("FY26 accounts — Contoso Pty Ltd")
	if !bas.Feature.ShipWhenDone || bas.Feature.Quick || !quick.Feature.Quick || !quick.Feature.ShipWhenDone || len(quick.Tasks) != 1 ||
		fy.Feature.ShipWhenDone {
		t.Fatalf("filed %+v, %+v with %+v, and %+v", bas.Feature, quick.Feature, quick.Tasks, fy.Feature)
	}
	fix := quick.Tasks[0]

	// The planner breaks Q1 BAS and FY26 down from their templates.
	rec.wait(30*time.Second, "planner", "completed", bas.Tasks[0].Key)
	rec.wait(30*time.Second, "planner", "completed", fy.Tasks[0].Key)
	byTitle := func(f client.FeatureDetail) map[string]client.Task {
		out := map[string]client.Task{}
		for _, tk := range admin.feature(f.Feature.Key).Tasks {
			out[tk.Title] = tk
		}
		return out
	}
	basTasks, fyTasks := byTitle(bas), byTitle(fy)
	collect, reconcile, draft, lodge := basTasks["Collect bank statements"], basTasks["Reconcile bank feed"], basTasks["Draft the BAS"], basTasks["Lodge the BAS"]
	assets := fyTasks["Update the fixed asset register"]
	for name, tk := range map[string]client.Task{"collect": collect, "reconcile": reconcile, "draft": draft, "lodge": lodge, "assets": assets} {
		if tk.Key == "" {
			t.Fatalf("the planner filed no %s Task", name)
		}
		if strings.Contains(tk.Description, "\n") || tk.Description == "" {
			t.Fatalf("%s has the description %q, want one line", tk.Key, tk.Description)
		}
	}

	// The drafter asks Mai about March's statements while collecting, and waits holding Collect.
	asked := rec.wait(30*time.Second, "drafter", "asked", collect.Key)
	question := strings.Fields(asked.Text)[0]
	if !strings.Contains(asked.Text, "aimed at "+bot.PersonaMai+": \"Statements for March are missing — ask Northwind?\"") {
		t.Fatalf("the drafter asked %s", asked)
	}
	// Mai puts it to Northwind, Collect waiting in Awaiting client, and moves it back once answered.
	if parked := rec.wait(15*time.Second, bot.PersonaMai, "moved", collect.Key); !strings.Contains(parked.Text,
		"from "+inProgress.Name+" to "+awaiting.Name+" until "+question) {
		t.Fatalf("Mai moved Collect: %s", parked)
	}
	rec.wait(15*time.Second, bot.PersonaMai, "completed", question)
	rec.wait(15*time.Second, "drafter", "answered", collect.Key)
	rec.wait(15*time.Second, "drafter", "completed", collect.Key)

	// With Kai away, Reconcile (its blocker ended) and the asset register wait in Backlog: next
	// offers neither to the drafter, who has the Skills both need, and neither is takeable.
	time.Sleep(time.Duration(3*bot.Fast.Wait) * time.Second / 2)
	drafter := dialAs(t, url, &member{name: "drafter", token: crew.Members["drafter"].Token, session: bot.NewSession()})
	takeable := drafter.takeable()
	for _, tk := range []client.Task{reconcile, assets} {
		d := admin.task(tk.Key)
		if d.Status.ID != backlog.ID || d.Task.Blocked || slices.Contains(takeable, tk.Key) || len(d.Claims) != 0 {
			t.Fatalf("with Kai away, %s is in %s, blocked %v, takeable by the drafter %v, with Claims %+v", tk.Key, d.Status.Name,
				d.Task.Blocked, slices.Contains(takeable, tk.Key), d.Claims)
		}
	}
	// Kai comes back and moves them to Todo, one a round; the drafter takes each, after its move
	// in the trail (checked below: the reports race, the drafter's next waking on Kai's write).
	start(kaiBot)
	for _, tk := range []client.Task{reconcile, assets} {
		rec.wait(15*time.Second, bot.PersonaKai, "moved", tk.Key)
		rec.wait(15*time.Second, "drafter", "took", tk.Key)
	}

	// The BAS is drafted and handed over to tax-review, In review; reviewer-tax completes it.
	handed := rec.wait(30*time.Second, "drafter", "handed over", draft.Key)
	if !strings.Contains(handed.Text, "to "+bot.SkillTaxReview+", now "+inReview.Name) {
		t.Fatalf("the draft was handed over: %s", handed)
	}
	rec.wait(30*time.Second, "reviewer-tax", "completed", draft.Key)

	// The quick fix goes to review and ships when reviewer-tax completes it.
	if h := rec.wait(30*time.Second, "drafter", "handed over", fix.Key); !strings.Contains(h.Text, "to "+bot.SkillReview+", now "+inReview.Name) {
		t.Fatalf("the quick fix was handed over: %s", h)
	}
	rec.wait(30*time.Second, "reviewer-tax", "completed", fix.Key)
	eventually(t, 5*time.Second, "the quick Feature shipping", func() bool { return admin.feature(quick.Feature.Key).Feature.State == client.FeatureStateShipped })

	// Mai lodges the BAS, and Q1 BAS ships itself.
	rec.wait(30*time.Second, bot.PersonaMai, "completed", lodge.Key)
	eventually(t, 5*time.Second, "Q1 BAS shipping", func() bool { return admin.feature(bas.Feature.Key).Feature.State == client.FeatureStateShipped })

	// Stop the bots and revoke their tokens, which ends any Claim still held; then check the record.
	stopBots()
	if err := crew.Revoke(context.Background(), admin.c); err != nil {
		t.Fatal(err)
	}
	for _, e := range rec.find("", "") {
		if e.What == "failed" || e.What == "lost" || e.What == "refused" || e.What == "stopped" {
			t.Errorf("a bot reported %s", e)
		}
	}
	mu.Lock()
	for name, err := range ended {
		if err != nil {
			t.Errorf("%s ended with %v", name, err)
		}
	}
	if polls < 20 || len(heldBacklog) > 0 {
		t.Errorf("the watcher polled the backlog Statuses %d times and saw holders in Backlog: %v", polls, heldBacklog)
	}
	mu.Unlock()

	trail := admin.activity()
	tasks := map[string]client.TaskDetail{}
	for _, tk := range admin.tasks(client.ListTasksParams{}) {
		tasks[tk.ID] = admin.task(tk.Key)
	}
	predicted, named := replay(t, trail, statuses)
	kind := map[string]client.StatusKind{}
	for _, s := range statuses {
		kind[s.ID] = s.Kind
	}
	// A Status a Member names during a Claim, moving the Task (Mai's Awaiting client, and Todo once
	// answered) or handing it over into it (a hand-back to Todo), is where the Task stays when the
	// Claim ends, unless it is in progress and the Claim ends other than by that Handover.
	type naming struct {
		seq  int64
		kind client.StatusKind
	}
	claimedAt, lastNamed := map[string]int64{}, map[string]naming{}
	for _, en := range trail {
		switch en.Kind {
		case client.ActivityKindTaskClaimed:
			claimedAt[en.SubjectID] = en.Seq
		case client.ActivityKindTaskStatusSet:
			s, _ := en.Payload["to"].(string)
			lastNamed[en.SubjectID] = naming{en.Seq, kind[s]}
		case client.ActivityKindTaskHandedOver:
			if s, _ := en.Payload["status_id"].(string); s != "" {
				lastNamed[en.SubjectID] = naming{en.Seq, kind[s]}
			}
		}
	}
	for _, d := range tasks {
		cs := d.Claims
		if d.Task.Claim != nil {
			t.Errorf("%s is still held by %s after the tokens were revoked", d.Task.Key, d.Task.Claim.HolderID)
		}
		want := restingKind(d, cs, named[d.Task.ID])
		if n := lastNamed[d.Task.ID]; d.Task.State == client.TaskStateOpen && len(cs) > 0 && n.seq > claimedAt[d.Task.ID] {
			want = n.kind
			if last := cs[len(cs)-1].HowEnded; want == client.StatusKindInProgress && (last == nil || *last != client.ClaimEndHandedOver) {
				want = client.StatusKindTodo
			}
		}
		if d.Status.ID != d.Task.StatusID || d.Status.Kind != want {
			t.Errorf("%s is %s, its last Claim ended %v, and it is in %s (%s); want a %s Status", d.Task.Key, d.Task.State, lastEnd(cs),
				d.Status.Name, d.Status.Kind, want)
		}
		if predicted[d.Task.ID] != d.Task.StatusID {
			t.Errorf("%s is in %s, but its Activity puts it in %s", d.Task.Key, d.Status.Name, predicted[d.Task.ID])
		}
	}

	tr := trailOf(t, trail)
	tr.checkClaims(crew)
	// The Statuses changed once, in the first Setup, before anything was filed.
	if sc := tr.of(client.ActivityKindStatusesChanged, ""); len(sc) != 1 || sc[0].Seq > tr.of(client.ActivityKindTaskFiled, "")[0].Seq {
		t.Errorf("the Statuses changed %+v", sc)
	}
	// Reconcile and the asset register were filed into Backlog and moved out by Kai alone.
	for _, tk := range []client.Task{reconcile, assets} {
		filed := tr.one(client.ActivityKindTaskFiled, tk.ID)
		moves := tr.of(client.ActivityKindTaskStatusSet, tk.ID)
		claims := tr.of(client.ActivityKindTaskClaimed, tk.ID)
		if filed.Payload["status_id"] != backlog.ID || len(moves) != 1 || *moves[0].ActorID != kai || moves[0].Payload["from"] != backlog.ID ||
			moves[0].Payload["to"] != todo.ID || len(claims) == 0 || claims[0].Seq < moves[0].Seq {
			t.Errorf("%s: filed %+v, moved %+v, claimed %+v", tk.Key, filed, moves, claims)
		}
	}
	// Only Mai moves a Task into Awaiting client, from In progress, and out of it, to Todo; nothing is
	// filed there. Every Claim the watcher saw on a Task in Awaiting client began before the Task's
	// move there.
	parkedAt := map[string]int64{}
	for _, en := range tr.of(client.ActivityKindTaskStatusSet, "") {
		from, to := en.Payload["from"], en.Payload["to"]
		if from != awaiting.ID && to != awaiting.ID {
			continue
		}
		if *en.ActorID != mai || (to == awaiting.ID && from != inProgress.ID) || (from == awaiting.ID && to != todo.ID) {
			t.Errorf("seq %d: %s moved from %v to %v by %s", en.Seq, en.SubjectID, from, to, *en.ActorID)
		}
		if _, ok := parkedAt[en.SubjectID]; !ok && to == awaiting.ID {
			parkedAt[en.SubjectID] = en.Seq
		}
	}
	for _, en := range tr.of(client.ActivityKindTaskFiled, "") {
		if en.Payload["status_id"] == awaiting.ID {
			t.Errorf("seq %d: %s filed into %s", en.Seq, en.SubjectID, awaiting.Name)
		}
	}
	mu.Lock()
	for claim, tk := range heldAwaiting {
		var began int64
		for _, en := range tr.of(client.ActivityKindTaskClaimed, tk.ID) {
			if en.Payload["claim_id"] == claim {
				began = en.Seq
			}
		}
		if at, ok := parkedAt[tk.ID]; began == 0 || !ok || began > at {
			t.Errorf("%s was held in %s under Claim %s, which did not begin before its move there", tk.Key, awaiting.Name, claim)
		}
	}
	mu.Unlock()
	// The question: filed aimed at Mai, blocking Collect in the same write, inside the drafter's one
	// Claim on Collect; claimed by Mai alone; answered before Collect completed, which came before
	// Reconcile's move.
	q := tasks[func() string {
		for _, d := range tasks {
			if d.Task.Key == question {
				return d.Task.ID
			}
		}
		return ""
	}()]
	qFiled := tr.one(client.ActivityKindTaskFiled, q.Task.ID)
	if next := tr.at(qFiled.Seq + 1); next.Kind != client.ActivityKindTaskBlockerAdded || next.SubjectID != collect.ID ||
		qFiled.Payload["aimed_at_id"] != mai || qFiled.Payload["blocks"] != collect.ID || *qFiled.ActorID != id("drafter") {
		t.Errorf("the question filed %+v, then %+v", qFiled, next)
	}
	if len(q.Claims) != 1 || q.Claims[0].HolderID != mai || *q.Claims[0].HowEnded != client.ClaimEndCompleted || q.Feature.ID != bas.Feature.ID ||
		len(q.Notes) == 0 || !strings.Contains(q.Notes[len(q.Notes)-1].Body, "March statements") {
		t.Errorf("the question %s: Claims %+v, Notes %+v", q.Task.Key, q.Claims, q.Notes)
	}
	collectClaim, collectDone := tr.one(client.ActivityKindTaskClaimed, collect.ID), tr.one(client.ActivityKindTaskCompleted, collect.ID)
	qClaim, qDone := tr.one(client.ActivityKindTaskClaimed, q.Task.ID), tr.one(client.ActivityKindTaskCompleted, q.Task.ID)
	reconcileMoved := tr.one(client.ActivityKindTaskStatusSet, reconcile.ID)
	if !(collectClaim.Seq < qFiled.Seq && qFiled.Seq < qDone.Seq && qDone.Seq < collectDone.Seq && collectDone.Seq < reconcileMoved.Seq) ||
		collectDone.Payload["claim_id"] != collectClaim.Payload["claim_id"] {
		t.Errorf("Collect claimed at %d, its question filed at %d and answered at %d, Collect completed at %d, Reconcile moved at %d",
			collectClaim.Seq, qFiled.Seq, qDone.Seq, collectDone.Seq, reconcileMoved.Seq)
	}
	// Collect, held by the drafter all along, went to Awaiting client once Mai saw the question and
	// back to Todo once she had the answer, both by her, before the question ended and unblocked it.
	if moves := tr.of(client.ActivityKindTaskStatusSet, collect.ID); len(moves) != 2 ||
		moves[0].Payload["to"] != awaiting.ID || moves[1].Payload["to"] != todo.ID ||
		!(qFiled.Seq < moves[0].Seq && moves[0].Seq < qClaim.Seq && qClaim.Seq < moves[1].Seq && moves[1].Seq < qDone.Seq) {
		t.Errorf("Collect moved %+v; its question filed at %d, claimed at %d and completed at %d", moves, qFiled.Seq, qClaim.Seq, qDone.Seq)
	}
	if cd := tasks[collect.ID]; len(cd.Observations) != 1 || cd.Observations[0].Outcome != client.DidntWork {
		t.Errorf("Collect's Observations %+v", cd.Observations)
	}
	// The draft: handed over by the drafter into In review, then claimed and completed by reviewer-tax.
	dd := tasks[draft.ID]
	ho := tr.one(client.ActivityKindTaskHandedOver, draft.ID)
	if ho.Payload["status_id"] != inReview.ID || len(dd.Claims) != 2 || dd.Claims[0].HolderID != id("drafter") ||
		*dd.Claims[0].HowEnded != client.ClaimEndHandedOver || dd.Claims[1].HolderID != id("reviewer-tax") ||
		*dd.Claims[1].HowEnded != client.ClaimEndCompleted || dd.Status.Name != bot.StatusLodged {
		t.Errorf("the draft: handed over %+v, Claims %+v, in %s", ho, dd.Claims, dd.Status.Name)
	}
	// Q1 BAS shipped by ship-when-done in Mai's completion of Lodge, which filed its Retrospective;
	// the quick Feature in reviewer-tax's completion of its review, with no Retrospective.
	for _, c := range []struct {
		f      client.FeatureDetail
		last   client.Task
		by     string
		quick  bool
		retros int
	}{{bas, lodge, mai, false, 1}, {quick, fix, id("reviewer-tax"), true, 0}} {
		ships := tr.of(client.ActivityKindFeatureShipped, c.f.Feature.ID)
		done := tr.one(client.ActivityKindTaskCompleted, c.last.ID)
		if len(ships) != 1 || ships[0].Seq != done.Seq+1 || *ships[0].ActorID != c.by || ships[0].Payload["ship_when_done"] != true ||
			(ships[0].Payload["quick"] == true) != c.quick {
			t.Errorf("%s shipped %+v after %s completed at %d", c.f.Feature.Key, ships, c.last.Key, done.Seq)
		}
		retros := 0
		for _, d := range tasks {
			if d.Feature.ID == c.f.Feature.ID && d.Task.Kind == client.Retrospective {
				retros++
			}
		}
		if retros != c.retros {
			t.Errorf("%s has %d Retrospectives, want %d", c.f.Feature.Key, retros, c.retros)
		}
	}
	// The workpapers are in the repository, committed, and attached as small text Evidence.
	paper, err := os.ReadFile(filepath.Join(repo, "northwind-traders", "2026-q1", "bank-reconciliation.txt"))
	if err != nil || !strings.Contains(string(paper), reconcile.Key+"  drafter: At 31 March 2026") {
		t.Errorf("the bank reconciliation workpaper: %v\n%s", err, paper)
	}
	if ev := tasks[reconcile.ID].Evidence; len(ev) != 1 || ev[0].Filename != "bank-reconciliation.txt" || ev[0].ContentType != "text/plain; charset=utf-8" ||
		ev[0].Size > 4096 {
		t.Errorf("Reconcile's Evidence %+v", ev)
	}
	if ev := tasks[lodge.ID].Evidence; len(ev) != 1 || ev[0].Filename != "lodgement.txt" || ev[0].AttachedBy != mai {
		t.Errorf("Lodge's Evidence %+v", ev)
	}
	if out := gitOutput(t, repo, "status", "--porcelain"); out != "" {
		t.Errorf("the repository has changes not committed:\n%s", out)
	}
	if log := gitOutput(t, repo, "log", "--format=%an %s"); !strings.Contains(log, "drafter "+reconcile.Key+": ") || !strings.Contains(log, bot.PersonaMai+" "+lodge.Key+": ") {
		t.Errorf("the repository's log:\n%s", log)
	}
	// Every Note is one sentence, and every question carries one.
	for _, d := range tasks {
		for _, n := range d.Notes {
			if strings.Count(strings.TrimSuffix(n.Body, "."), ". ") > 0 || strings.Contains(n.Body, "\n") {
				t.Errorf("%s has the Note %q, more than a sentence", d.Task.Key, n.Body)
			}
		}
		if d.Task.AimedAtID != nil && !strings.HasSuffix(d.Task.Title, "?") {
			t.Errorf("the question %s is %q", d.Task.Key, d.Task.Title)
		}
	}
}

func gitOutput(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_SYSTEM="+os.DevNull)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	return strings.TrimSpace(string(out))
}
