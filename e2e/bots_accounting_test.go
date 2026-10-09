package e2e

import (
	"context"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/tools/bots/bot"
)

// The accounting preset at work on a fresh Install: a Project worked by people alone — Lan Pham who
// gathers, Mai Tran who prepares, and Kai Nguyen, the partner, who owns the work, answers the
// questions about clients and reviews and lodges every return — with no agent and no Workspace,
// each persona a bot with a token of their own. As they work, the test checks that:
//
//   - Setup is idempotent: run again, it changes nothing but the tokens. TAX's Workflow is Backlog
//     (a hold) · Gather · Prepare · Partner review, Partner review leading into Done along
//     "lodged" or back to Prepare along "needs changes"; the Organisation has no agent and no
//     Workspace.
//   - A Task in Backlog is never offered: while Kai is away the Q1 BAS and the financial
//     statements wait there untaken and not takeable; once Kai is back he moves each to Gather, and
//     Lan takes each after its move.
//   - Lan's question about March's statements is aimed at Kai, lands beside nothing (the BAS has no
//     Parent) and blocks the BAS; only Kai takes it, and the BAS goes on once it is answered.
//   - Each return passes from Lan to Mai to Kai along the outcomes, no one working it under two
//     Skills; Kai sends the statements back to Prepare once, Mai fixes them, and Kai lodges them.
//   - The tax return, blocked by the statements, waits until they are lodged; then Kai completes the
//     Parent, with no Retrospective, since TAX's Workflow has no retro Step.
//
// Then, with the bots stopped and their tokens revoked, every Task is at exactly one Step or none,
// as its state and a replay of its Activity say.
func TestBotsAccounting(t *testing.T) {
	in := newInstall(t)
	url := in.servers[0].url
	ctx := t.Context()
	admin := dialAs(t, url, in.ada)
	opts := bot.Options{Preset: &bot.Accounting, Personas: true, Timeout: bot.Fast.Timeout, TokenName: "bots"}
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
	lan, mai, kai := id(bot.PersonaLan), id(bot.PersonaMai), id(bot.PersonaKai)

	// TAX's Workflow is the accounting one; there is no agent and no Workspace.
	wf := admin.workflow(bot.ProjectTax)
	if names := stepNamesOf(wf); !slices.Equal(names, specStepNames(&bot.Accounting)) {
		t.Fatalf("TAX's Workflow is %v", names)
	}
	steps := map[string]client.WorkflowStep{}
	for _, s := range wf.Steps {
		steps[s.Name] = s
	}
	backlog, gather, prepare, review := steps[bot.StepBacklog], steps[bot.StepGather], steps[bot.StepPrepare], steps[bot.StepPartnerReview]
	if backlog.SkillID != nil || gather.SkillID == nil || prepare.SkillID == nil || review.SkillID == nil {
		t.Fatalf("the Steps %+v", wf.Steps)
	}
	var outs []string
	for _, k := range wf.Connectors {
		to := "Done"
		for _, s := range wf.Steps {
			if k.ToStepID != nil && s.ID == *k.ToStepID {
				to = s.Name
			}
		}
		for _, s := range wf.Steps {
			if s.ID == k.FromStepID {
				outs = append(outs, s.Name+" "+k.Name+" "+to)
			}
		}
	}
	if want := []string{"Gather gathered Prepare", "Prepare prepared Partner review", "Partner review lodged Done",
		"Partner review needs changes Prepare"}; !slices.Equal(outs, want) {
		t.Fatalf("the Connectors are %v, want %v", outs, want)
	}
	var agents client.MemberList
	in.ada.json(&agents, "member", "list", "--kind", "agent")
	var workspaces client.WorkspaceList
	in.ada.json(&workspaces, "workspace", "list")
	if len(agents.Items) != 0 || len(workspaces.Items) != 0 || len(crew.Workspaces) != 0 {
		t.Fatalf("the agents %+v and the Workspaces %+v", agents.Items, workspaces.Items)
	}

	// The personas start, Kai held back so what waits in Backlog stays there for a while. A watcher
	// looks for Tasks held at the Backlog, which must never be.
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
	polls := 0
	wg.Go(func() {
		for sleepCtx(runCtx, 100*time.Millisecond) {
			res, err := admin.c.ListTasksWithResponse(runCtx, &client.ListTasksParams{Step: &backlog.ID, Limit: ptr(500)})
			if err != nil || res.JSON200 == nil {
				continue
			}
			mu.Lock()
			polls++
			for _, tk := range res.JSON200.Items {
				if tk.Claim != nil {
					heldBacklog = append(heldBacklog, tk.Key+" held by "+tk.Claim.HolderID)
				}
			}
			mu.Unlock()
		}
	})
	stopBots := sync.OnceFunc(func() {
		stopRunning()
		wg.Wait()
	})
	t.Cleanup(stopBots)

	// The admin files three of the preset's Tasks for Kai, the partner.
	file := func(title string) client.TaskDetail {
		tmpl := bot.Accounting.Template(title)
		if tmpl == nil {
			t.Fatalf("the preset has no Task %q", title)
		}
		d, err := crew.File(ctx, admin.c, *tmpl, "")
		if err != nil {
			t.Fatal(err)
		}
		if d.Task.OwnerID != kai || d.Task.Description == "" {
			t.Fatalf("filed %+v", d.Task)
		}
		return *d
	}
	bas := file("Q1 BAS — Northwind Traders")
	fy := file("FY26 accounts — Contoso Pty Ltd")
	gst := file("Fix the GST code on invoice 1042")
	if deref(bas.Task.StepID) != backlog.ID || deref(gst.Task.StepID) != prepare.ID || fy.Task.SubtaskCounts == nil || len(fy.Subtasks) != 2 ||
		fy.Task.StepID != nil {
		t.Fatalf("filed %+v, %+v with %+v, and %+v", bas.Task, fy.Task, fy.Subtasks, gst.Task)
	}
	var statements, taxReturn client.Task
	for _, tk := range fy.Subtasks {
		switch tk.Title {
		case "Financial statements":
			statements = tk
		case "Company tax return":
			taxReturn = tk
		}
	}
	if deref(statements.StepID) != backlog.ID || deref(taxReturn.StepID) != gather.ID || !taxReturn.Blocked {
		t.Fatalf("the Subtasks %+v and %+v", statements, taxReturn)
	}

	// With Kai away, the BAS and the statements wait in Backlog: Lan, who has the Skill Gather
	// carries, is offered neither.
	time.Sleep(time.Duration(3*bot.Fast.Wait) * time.Second / 2)
	lanAPI := dialAs(t, url, &member{name: bot.PersonaLan, token: crew.Members[bot.PersonaLan].Token, session: bot.NewSession()})
	takeable := lanAPI.takeable()
	for _, tk := range []client.Task{bas.Task, statements} {
		d := admin.task(tk.Key)
		if deref(d.Task.StepID) != backlog.ID || d.Task.Blocked || slices.Contains(takeable, tk.Key) || len(d.Claims) != 0 {
			t.Fatalf("with Kai away, %s is at %s, blocked %v, takeable by Lan %v, with Claims %+v", tk.Key, where(d),
				d.Task.Blocked, slices.Contains(takeable, tk.Key), d.Claims)
		}
	}
	// Mai prepares the GST fix meanwhile; it waits at Partner review for Kai.
	rec.wait(30*time.Second, bot.PersonaMai, "advanced", gst.Task.Key)
	if d := admin.task(gst.Task.Key); deref(d.Task.StepID) != review.ID || d.Task.Claim != nil {
		t.Fatalf("the GST fix is at %s, held by %+v", where(d), d.Task.Claim)
	}

	// Kai comes back and moves them to Gather, one a round; Lan takes each.
	start(kaiBot)
	for _, tk := range []client.Task{bas.Task, statements} {
		rec.wait(15*time.Second, bot.PersonaKai, "moved", tk.Key)
		rec.wait(15*time.Second, bot.PersonaLan, "took", tk.Key)
	}

	// Lan asks Kai about March's statements while gathering the BAS, and waits holding it.
	asked := rec.wait(30*time.Second, bot.PersonaLan, "asked", bas.Task.Key)
	question := strings.Fields(asked.Text)[0]
	if !strings.Contains(asked.Text, "aimed at "+bot.PersonaKai+": \"Statements for March are missing — ask Northwind?\"") {
		t.Fatalf("Lan asked %s", asked)
	}
	rec.wait(15*time.Second, bot.PersonaKai, "completed", question)
	rec.wait(15*time.Second, bot.PersonaLan, "answered", bas.Task.Key)

	// Every return is lodged; the statements once sent back; then Kai completes the Parent.
	rec.wait(60*time.Second, bot.PersonaKai, "handed back", statements.Key)
	for _, tk := range []client.Task{gst.Task, bas.Task, statements, taxReturn} {
		rec.wait(60*time.Second, bot.PersonaKai, "completed", tk.Key)
	}
	rec.wait(15*time.Second, bot.PersonaKai, "completed", fy.Task.Key)

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
		t.Errorf("the watcher polled the Backlog %d times and saw holders: %v", polls, heldBacklog)
	}
	mu.Unlock()

	trail := admin.activity()
	tasks := map[string]client.TaskDetail{}
	for _, tk := range admin.tasks(client.ListTasksParams{}) {
		tasks[tk.ID] = admin.task(tk.Key)
	}
	workflows := map[string]client.Workflows{wf.ProjectID: wf}
	predicted := replay(t, trail, workflows)
	for _, d := range tasks {
		if d.Task.Claim != nil {
			t.Errorf("%s is still held by %s after the tokens were revoked", d.Task.Key, d.Task.Claim.HolderID)
		}
		atOneStep(t, d, workflows)
		if predicted[d.Task.ID] != deref(d.Task.StepID) {
			t.Errorf("%s is at %s, but its Activity puts it at %q", d.Task.Key, where(d), predicted[d.Task.ID])
		}
		// No one works a Task under two Skills: each Step is a different person's.
		holders := map[string]string{}
		for _, c := range d.Claims {
			sk := deref(c.SkillID)
			if prev, ok := holders[c.HolderID]; ok && prev != sk {
				t.Errorf("%s was held by %s under two Skills", d.Task.Key, c.HolderID)
			}
			holders[c.HolderID] = sk
		}
	}
	holdersOf := func(key string) []string {
		var out []string
		for _, c := range admin.task(key).Claims {
			out = append(out, c.HolderID)
		}
		return out
	}
	if h := holdersOf(bas.Task.Key); !slices.Equal(h, []string{lan, mai, kai}) {
		t.Errorf("the BAS was held by %v, want Lan, Mai, Kai", h)
	}
	if h := holdersOf(statements.Key); !slices.Equal(h, []string{lan, mai, kai, mai, kai}) {
		t.Errorf("the statements were held by %v, want Lan, Mai, Kai, Mai, Kai", h)
	}

	tr := trailOf(t, trail)
	tr.checkClaims(crew)
	// The BAS and the statements were filed into Backlog and moved out by Kai alone, before their
	// first claim; the tax return, filed there to wait on its blocker, was moved by the admin once
	// its blocker was set.
	for _, c := range []struct {
		tk client.Task
		by string
	}{{bas.Task, kai}, {statements, kai}, {taxReturn, in.ada.id}} {
		filed := tr.one(client.ActivityKindTaskFiled, c.tk.ID)
		moves := tr.of(client.ActivityKindTaskMoved, c.tk.ID)
		claims := tr.of(client.ActivityKindTaskClaimed, c.tk.ID)
		if filed.Payload["step_id"] != backlog.ID || len(moves) != 1 || deref(moves[0].ActorID) != c.by || moves[0].Payload["from"] != backlog.ID ||
			moves[0].Payload["to"] != gather.ID || len(claims) == 0 || claims[0].Seq < moves[0].Seq {
			t.Errorf("%s: filed %+v, moved %+v, claimed %+v", c.tk.Key, filed, moves, claims)
		}
	}
	// The question: filed by Lan aimed at Kai, blocking the BAS in the same write, inside Lan's
	// Claim on it; claimed by Kai alone; answered before the BAS left Gather.
	var q client.TaskDetail
	for _, d := range tasks {
		if d.Task.Key == question {
			q = d
		}
	}
	qFiled := tr.one(client.ActivityKindTaskFiled, q.Task.ID)
	if next := tr.at(qFiled.Seq + 1); next.Kind != client.ActivityKindTaskBlockerAdded || next.SubjectID != bas.Task.ID ||
		qFiled.Payload["aimed_at_id"] != kai || qFiled.Payload["blocks"] != bas.Task.ID || deref(qFiled.ActorID) != lan || q.Task.ParentID != nil {
		t.Errorf("the question filed %+v, then %+v", qFiled, next)
	}
	if len(q.Claims) != 1 || q.Claims[0].HolderID != kai || *q.Claims[0].HowEnded != client.ClaimEndCompleted ||
		len(q.Notes) == 0 || !strings.Contains(q.Notes[len(q.Notes)-1].Body, "March statements") {
		t.Errorf("the question %s: Claims %+v, Notes %+v", q.Task.Key, q.Claims, q.Notes)
	}
	basGathered := tr.of(client.ActivityKindTaskAdvanced, bas.Task.ID)[0]
	if qDone := tr.one(client.ActivityKindTaskCompleted, q.Task.ID); qDone.Seq > basGathered.Seq || basGathered.Payload["outcome"] != "gathered" ||
		basGathered.Payload["from"] != gather.ID || basGathered.Payload["to"] != prepare.ID {
		t.Errorf("the question completed %+v; the BAS advanced %+v", qDone, basGathered)
	}
	// The statements went back from Partner review to Prepare along "needs changes", with Kai's Note,
	// and were lodged after Mai's fix.
	var outcomes []string
	for _, en := range tr.of(client.ActivityKindTaskAdvanced, statements.ID) {
		outcomes = append(outcomes, en.Payload["outcome"].(string))
	}
	lodged := tr.one(client.ActivityKindTaskCompleted, statements.ID)
	if !slices.Equal(outcomes, []string{"gathered", "prepared", "needs changes", "prepared"}) || lodged.Payload["outcome"] != bot.OutcomeLodged ||
		deref(lodged.ActorID) != kai {
		t.Errorf("the statements advanced along %v, then %+v", outcomes, lodged)
	}
	sd := tasks[statements.ID]
	var notes []string
	for _, n := range sd.Notes {
		notes = append(notes, n.Body)
	}
	tmpl := bot.Accounting.Template("FY26 accounts — Contoso Pty Ltd").Items[0]
	if !slices.Contains(notes, tmpl.HandBack) || !slices.Contains(notes, tmpl.Fix) {
		t.Errorf("the statements' Notes %q lack the hand-back or the fix", notes)
	}
	// The tax return was claimed only after the statements were lodged; the Parent was completed by
	// Kai after both, and filed no Retrospective.
	if cl := tr.of(client.ActivityKindTaskClaimed, taxReturn.ID); len(cl) == 0 || cl[0].Seq < lodged.Seq {
		t.Errorf("the tax return was claimed %+v, before the statements were lodged at %d", cl, lodged.Seq)
	}
	fyDone := tr.one(client.ActivityKindTaskCompleted, fy.Task.ID)
	if deref(fyDone.ActorID) != kai || fyDone.Seq < tr.one(client.ActivityKindTaskCompleted, taxReturn.ID).Seq {
		t.Errorf("the Parent completed %+v", fyDone)
	}
	for _, d := range tasks {
		if d.Task.Kind == client.Retrospective {
			t.Errorf("%s is a Retrospective, though TAX's Workflow has no retro Step", d.Task.Key)
		}
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
