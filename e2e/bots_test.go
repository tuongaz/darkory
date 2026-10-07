package e2e

import (
	"context"
	"fmt"
	"reflect"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/tools/bots/bot"
)

// The bots of tools/bots/bot work as the agent Members of a fresh Install with two Teams, while
// the test acts as its three humans: ada the admin, kai who owns the Feature and directs the
// agents, and mai who answers their question. As they work, the test checks that:
//
//   - Setup is idempotent: run again, it changes nothing but the tokens.
//   - A Claim moves a Todo Task to In progress, and GET /v1/tasks shows the holder and Heartbeat.
//   - The lapser's Claim lapses, Darkory records it with no actor, and its Task returns to Todo.
//   - kai takes back the stuck agent's Task: it returns to Todo and the agent's CLI exits 3.
//   - next never offers a Backlog Task: the prober gets nothing until mai moves one to Todo, then
//     exactly that one, and no Task ever shows a holder while in a Backlog Status.
//   - A builder's question aimed at mai blocks its Task and is mai's to take; completing it
//     unblocks the Task, which the builder held throughout.
//   - A Handover naming In review lands there, and the reviewer takes it.
//   - Ship is refused while Tasks are open and succeeds once they have ended.
//   - The Retrospective's proposal is published as version 2 by the reviewer.
//
// Then, with the bots stopped, every Task's Status agrees with its state and last Claim and with
// a replay of its Activity, and the whole trail is gapless and in the order the scenarios imply.
func TestBots(t *testing.T) {
	// On an Install init seeded with its roster: Setup keeps planner, reviewer and retro, which
	// init made with the same names and Skills.
	in := newInstallWith(t)
	ada := in.ada
	if out := ada.ok("agent", "list"); !strings.Contains(out, "planner ") || !strings.Contains(out, "builder ") {
		t.Fatalf("init seeded no roster:\n%s", out)
	}
	url := in.servers[0].url
	ctx := t.Context()
	admin := dialAs(t, url, ada)

	// The Organisation, made by the bots' own Setup, twice.
	opts := bot.Options{Team: "WEB", TeamName: "Web", Ops: "OPS", OpsName: "Ops", Manager: "kai", Ask: "mai",
		Humans: []string{"kai", "mai"}, Timeout: bot.Fast.Timeout, TokenName: "bots"}
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
	ada.ok("report-to", "kai", "ada")
	kai, mai := in.human("kai"), in.human("mai")
	id := func(name string) string { return crew.Members[name].ID }
	for _, s := range bot.Roster {
		res, err := admin.c.GetMemberWithResponse(ctx, s.Name)
		if err != nil || res.JSON200 == nil {
			t.Fatalf("reading %s: %v %s", s.Name, err, bodyOf(res))
		}
		m := res.JSON200
		if m.Member.Kind != client.Agent || m.Member.ManagerID == nil || *m.Member.ManagerID != kai.id || len(m.Skills) != len(s.Skills) {
			t.Fatalf("%s is %+v with Skills %+v", s.Name, m.Member, m.Skills)
		}
	}
	statuses := admin.statuses()
	status := map[string]client.Status{}
	for _, s := range statuses {
		status[s.Name] = s
	}
	todo, inProgress, inReview, backlog := status["Todo"], status["In progress"], status["In review"], status["Backlog"]
	// The rules name no Status, only a kind; the defaults' first todo-kind Status is Todo.
	if i := slices.IndexFunc(statuses, func(s client.Status) bool { return s.Kind == client.StatusKindTodo }); i < 0 || statuses[i].ID != todo.ID {
		t.Fatalf("the first todo-kind Status is not Todo: %+v", statuses)
	}

	// The bots start, and a watcher looks for a Backlog Task with a holder, which must never be.
	rec := &botLog{t: t}
	cfg := bot.Config{URL: url, Pace: bot.Fast, Report: rec.add, Binary: bin, Env: in.env()}
	runCtx, stopRunning := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	var mu sync.Mutex
	ended := map[string]error{}
	for _, b := range crew.Bots(cfg) {
		wg.Go(func() {
			err := b.Run(runCtx)
			mu.Lock()
			ended[b.Name()] = err
			mu.Unlock()
		})
	}
	var heldInBacklog []string
	polls := 0
	wg.Go(func() {
		name := backlog.Name
		for sleepCtx(runCtx, 100*time.Millisecond) {
			res, err := admin.c.ListTasksWithResponse(runCtx, &client.ListTasksParams{Status: &name, Limit: ptr(500)})
			if err != nil || res.JSON200 == nil {
				continue
			}
			mu.Lock()
			polls++
			for _, tk := range res.JSON200.Items {
				if tk.Claim != nil {
					heldInBacklog = append(heldInBacklog, tk.Key+" held by "+tk.Claim.HolderID)
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
	exited := func(name string) bool {
		mu.Lock()
		defer mu.Unlock()
		err, ok := ended[name]
		if ok && err != nil {
			t.Errorf("%s ended with %v", name, err)
		}
		return ok
	}

	// kai files the Feature; ada files the chores the lapser and stuck take.
	var checkout client.FeatureDetail
	kai.json(&checkout, "feature", "create", "--team", "WEB", "--title", "Checkout", "--body", "Customers pay for their basket.")
	fkey, bdKey := checkout.Feature.Key, checkout.Tasks[0].Key
	var chores client.FeatureDetail
	ada.json(&chores, "feature", "create", "--team", "OPS", "--title", "Chores")
	var logs, deploy client.TaskDetail
	ada.json(&logs, "file", "--feature", chores.Feature.Key, "--title", "Rotate the logs", "--skill", bot.SkillTriage)
	ada.json(&deploy, "file", "--feature", chores.Feature.Key, "--title", "Deploy to staging", "--skill", bot.SkillDeploy)

	// The lapser claims with a 2 s timeout and exits; the sweeper records the lapse.
	rec.wait(20*time.Second, "lapser", "went silent", logs.Task.Key)
	eventually(t, 15*time.Second, "the lapser exiting", func() bool { return exited("lapser") })
	// Reads show the Claim ended at its expiry at once; the Task stays In progress until the
	// sweeper records the lapse, within a second.
	eventually(t, 15*time.Second, "the lapse recorded", func() bool { return admin.task(logs.Task.Key).Task.StatusID == todo.ID })
	// GET /v1/tasks/{task} then shows it in the first todo-kind Status, with the lapse recorded.
	if d := admin.task(logs.Task.Key); len(d.Claims) != 1 || *d.Claims[0].HowEnded != client.ClaimEndLapsed || d.Claims[0].HolderID != id("lapser") ||
		d.Task.Claim != nil || d.Status.ID != todo.ID || d.Status.Kind != client.StatusKindTodo || d.Task.StatusID != todo.ID {
		t.Fatalf("the lapser's Task is in %s with Claims %+v", d.Status.Name, d.Claims)
	}

	// stuck holds its Task through the real CLI; GET /v1/tasks shows it In progress, held, with
	// a Heartbeat that keeps moving its expiry.
	rec.wait(20*time.Second, "stuck", "heartbeating", deploy.Task.Key)
	held := admin.inProgress(deploy.Task.Key)
	if c := held.Claim; c.HolderID != id("stuck") || c.HeartbeatTimeoutSeconds == nil || *c.HeartbeatTimeoutSeconds != bot.Fast.Timeout ||
		c.ModelLabel == nil || !c.ExpiresAt.After(time.Now()) {
		t.Fatalf("stuck's Claim as listed %+v", c)
	}
	time.Sleep(time.Duration(2*bot.Fast.Timeout+1) * time.Second)
	if later := admin.inProgress(deploy.Task.Key); later.Claim.ID != held.Claim.ID || !later.Claim.ExpiresAt.After(*held.Claim.ExpiresAt) {
		t.Fatalf("stuck's Claim was not kept alive: %+v, then %+v", held.Claim, later.Claim)
	}
	// kai, whom stuck reports to, takes it back; stuck's `darkory heartbeat` exits 3.
	kai.ok("take-back", deploy.Task.Key, "--reason", "it has been deploying for too long")
	tb := rec.wait(15*time.Second, "stuck", "taken back", deploy.Task.Key)
	if tb.Code != 3 || !strings.Contains(tb.Text, "was taken back") {
		t.Fatalf("stuck reported %s", tb)
	}
	eventually(t, 15*time.Second, "stuck stopping", func() bool { return exited("stuck") })
	if d := admin.task(deploy.Task.Key); d.Task.Claim != nil || d.Status.ID != todo.ID || len(d.Claims) != 1 ||
		*d.Claims[0].HowEnded != client.ClaimEndTakenBack {
		t.Fatalf("after the take-back the Task is in %s with Claims %+v", d.Status.Name, d.Claims)
	}

	// The planner breaks Checkout down; it cannot ship while its Tasks are open.
	planned := rec.wait(30*time.Second, "planner", "completed", bdKey)
	checkout = admin.feature(fkey)
	task := map[string]client.Task{}
	for _, tk := range checkout.Tasks {
		task[strings.TrimSuffix(tk.Title, " Checkout")] = tk
	}
	api, screen, review, qa := task["Build the API for"], task["Build the screen for"], task["Review"], task["QA"]
	help, demo, polish := task["Write the help page for"], task["Record a demo of"], task["Polish"]
	for name, tk := range map[string]client.Task{"api": api, "screen": screen, "review": review, "qa": qa, "help": help, "demo": demo, "polish": polish} {
		if tk.Key == "" {
			t.Fatalf("the planner filed no %s Task: %+v", name, checkout.Tasks)
		}
	}
	if bd := admin.task(bdKey); bd.Task.State != client.TaskStateDone || bd.Claims[0].HolderID != id("planner") ||
		!strings.HasPrefix(bd.Notes[len(bd.Notes)-1].Body, "Filed 7 Tasks") {
		t.Fatalf("the Break down %+v with Notes %+v", bd.Task, bd.Notes)
	}
	kai.refused(3, client.ErrorCodeTasksOpen, "feature", "ship", fkey)

	// The prober asks next again and again and gets nothing while its Tasks wait in the Backlog;
	// mai moves the help page to Todo, and the prober gets exactly that.
	eventually(t, 10*time.Second, "the prober asking five times after the Backlog was filed", func() bool {
		n := 0
		for _, e := range rec.find("prober", "nothing") {
			if e.At.After(planned.At) {
				n++
			}
		}
		return n >= 5
	})
	if took := rec.find("prober", "took"); len(took) > 0 {
		t.Fatalf("next offered the prober a Backlog Task: %s", took[0])
	}
	moved := time.Now()
	mai.ok("status", help.Key, "Todo")
	rec.wait(10*time.Second, "prober", "took", help.Key)
	if took := rec.find("prober", "took"); len(took) != 1 || took[0].Task != help.Key || !took[0].At.After(moved) {
		t.Fatalf("after the move the prober took %v", took)
	}
	rec.wait(15*time.Second, "prober", "completed", help.Key)

	// A builder asks mai a question that blocks its Task, and waits holding the Claim.
	asked := rec.wait(30*time.Second, "", "asked", screen.Key)
	asker := asked.Bot
	sd := admin.task(screen.Key)
	var question client.Task
	for _, b := range sd.Blockers {
		if b.AimedAtID != nil && *b.AimedAtID == mai.id {
			question = b
		}
	}
	if question.Key == "" || question.FeatureID != checkout.Feature.ID || !sd.Task.Blocked || sd.Task.Claim == nil ||
		sd.Task.Claim.HolderID != id(asker) || sd.Status.ID != inProgress.ID {
		t.Fatalf("while %s waits: %+v in %s, blocked by %+v", asker, sd.Task, sd.Status.Name, sd.Blockers)
	}
	if listed := admin.inProgress(screen.Key); !listed.Blocked || listed.Claim.HolderID != id(asker) || !listed.Claim.ExpiresAt.After(time.Now()) {
		t.Fatalf("GET /v1/tasks shows the waiting Task as %+v", listed)
	}
	if !slices.Contains(takeableKeys(mai), question.Key) {
		t.Fatalf("mai cannot take the question %s aimed at mai", question.Key)
	}
	builder := dialAs(t, url, &member{name: asker, token: crew.Members[asker].Token, session: bot.NewSession()})
	if keys := builder.takeable(); slices.Contains(keys, question.Key) {
		t.Fatalf("%s can take the question aimed at mai: %v", asker, keys)
	}
	waiting := sd.Task.Claim.ID
	var answering client.TaskDetail
	mai.json(&answering, "claim", question.Key, "--timeout", "0")
	mai.ok("complete", question.Key, "--note", "Yes: signed-out customers pay as guests.")
	answered := rec.wait(15*time.Second, asker, "answered", screen.Key)
	if !strings.Contains(answered.Text, "pay as guests") {
		t.Fatalf("%s read the answer as %s", asker, answered)
	}
	rec.wait(15*time.Second, asker, "completed", screen.Key)
	sd = admin.task(screen.Key)
	if len(sd.Claims) != 1 || sd.Claims[0].ID != waiting || *sd.Claims[0].HowEnded != client.ClaimEndCompleted ||
		len(sd.Observations) != 1 || sd.Observations[0].Outcome != client.DidntWork || sd.Observations[0].AuthorID != id(asker) ||
		len(sd.Evidence) != 1 || sd.Evidence[0].AttachedBy != id(asker) {
		t.Fatalf("the screen once built: Claims %+v, Observations %+v, Evidence %+v", sd.Claims, sd.Observations, sd.Evidence)
	}

	// The API is handed over to review, landing In review, and the reviewer takes it.
	handed := rec.wait(30*time.Second, "", "handed over", api.Key)
	if !strings.Contains(handed.Text, "now "+inReview.Name) {
		t.Fatalf("the API was handed over: %s", handed)
	}
	rec.wait(30*time.Second, "reviewer", "completed", api.Key)
	if ad := admin.task(api.Key); len(ad.Claims) != 2 || ad.Claims[0].HolderID != id(handed.Bot) || *ad.Claims[0].HowEnded != client.ClaimEndHandedOver ||
		ad.Claims[1].HolderID != id("reviewer") || *ad.Claims[1].HowEnded != client.ClaimEndCompleted || ad.Status.Name != "Done" {
		t.Fatalf("the API's Claims %+v, in %s", ad.Claims, ad.Status.Name)
	}

	// Review and QA, unblocked by both builds, are worked; ship is refused while the demo and
	// the polish wait in the Backlog, and succeeds once kai drops them.
	rec.wait(30*time.Second, "reviewer", "completed", review.Key)
	rec.wait(30*time.Second, "", "completed", qa.Key)
	kai.refused(3, client.ErrorCodeTasksOpen, "feature", "ship", fkey)
	kai.ok("drop", demo.Key, "--reason", "no release notes this time")
	kai.ok("drop", polish.Key, "--reason", "nothing worth a second pass")
	var shipped client.FeatureDetail
	kai.json(&shipped, "feature", "ship", fkey)
	retro := shipped.Tasks[len(shipped.Tasks)-1]
	if shipped.Feature.State != client.FeatureStateShipped || retro.Kind != client.Retrospective {
		t.Fatalf("shipped %+v with %+v", shipped.Feature, retro)
	}

	// retro proposes build-acme v2 from the builder's Observation; the reviewer publishes it.
	rec.wait(30*time.Second, "retro", "proposed", retro.Key)
	rec.wait(30*time.Second, "retro", "handed over", retro.Key)
	rec.wait(30*time.Second, "reviewer", "published", retro.Key)
	var v2 client.SkillDetail
	ada.json(&v2, "skill", "show", bot.SkillCompany)
	rd := admin.task(retro.Key)
	if v2.Skill.CurrentVersion != 2 || v2.Current.PublishedBy == nil || *v2.Current.PublishedBy != id("reviewer") ||
		!strings.Contains(v2.Current.Body, "From the Retrospective of "+fkey) || rd.Proposal == nil ||
		rd.Proposal.State != client.Published || rd.Proposal.AuthorID != id("retro") || rd.Task.State != client.TaskStateDone {
		t.Fatalf("%s is %+v; the Retrospective %+v with proposal %+v", bot.SkillCompany, v2, rd.Task, rd.Proposal)
	}

	// Stop the bots, then check the record as a whole.
	stopBots()
	for _, e := range rec.find("", "") {
		if e.What == "failed" || e.What == "lost" || e.What == "refused" || e.What == "stopped" {
			t.Errorf("a bot reported %s", e)
		}
	}
	for _, s := range bot.Roster {
		exited(s.Name)
	}
	if polls < 10 || len(heldInBacklog) > 0 {
		t.Errorf("the watcher polled the Backlog %d times and saw holders: %v", polls, heldInBacklog)
	}
	if took := rec.find("prober", "took"); len(took) != 1 {
		t.Errorf("the prober took %v", took)
	}

	trail := admin.activity()
	tasks := map[string]client.TaskDetail{}
	for _, tk := range admin.tasks(client.ListTasksParams{}) {
		tasks[tk.ID] = admin.task(tk.Key)
	}
	predicted, named := replay(t, trail, statuses)
	for _, d := range tasks {
		cs := d.Claims
		for i := 1; i < len(cs); i++ {
			if cs[i-1].EndedAt == nil || cs[i-1].EndedAt.After(cs[i].StartedAt) {
				t.Errorf("%s: Claim %s overlaps Claim %s", d.Task.Key, cs[i-1].ID, cs[i].ID)
			}
		}
		if d.Task.Claim != nil {
			t.Errorf("%s is still held by %s after the bots stopped", d.Task.Key, d.Task.Claim.HolderID)
		}
		if want := restingKind(d, cs, named[d.Task.ID]); d.Status.ID != d.Task.StatusID || d.Status.Kind != want {
			t.Errorf("%s is %s, its last Claim ended %v, and it is in %s (%s); want a %s Status", d.Task.Key, d.Task.State, lastEnd(cs),
				d.Status.Name, d.Status.Kind, want)
		}
		if predicted[d.Task.ID] != d.Task.StatusID {
			t.Errorf("%s is in %s, but its Activity puts it in %s", d.Task.Key, d.Status.Name, predicted[d.Task.ID])
		}
	}
	for _, k := range []string{demo.ID, polish.ID} {
		if d := tasks[k]; len(d.Claims) != 0 || d.Task.State != client.TaskStateDropped {
			t.Errorf("%s, filed into the Backlog and left there, is %s with Claims %+v", d.Task.Key, d.Task.State, d.Claims)
		}
	}

	tr := trailOf(t, trail)
	tr.checkClaims(crew)
	// The only Status moves Members made: the planner releasing review and QA once blocked, and
	// mai moving the help page. Darkory's own moves record none (decisions.md).
	sets := tr.of(client.ActivityKindTaskStatusSet, "")
	if len(sets) != 3 {
		t.Errorf("%d task.status_set entries, want 3: %+v", len(sets), sets)
	}
	for _, en := range sets {
		who := ""
		if en.ActorID != nil {
			who = *en.ActorID
		}
		from, to := en.Payload["from"], en.Payload["to"]
		switch {
		case en.SubjectID == help.ID && who == mai.id:
		case (en.SubjectID == review.ID || en.SubjectID == qa.ID) && who == id("planner"):
			if b := tr.of(client.ActivityKindTaskBlockerAdded, en.SubjectID); len(b) != 2 || b[1].Seq > en.Seq {
				t.Errorf("seq %d: the planner moved %s before both its blockers were set", en.Seq, en.SubjectID)
			}
		default:
			t.Errorf("seq %d: an unexpected Status move %+v", en.Seq, en)
		}
		if from != backlog.ID || to != todo.ID {
			t.Errorf("seq %d: a move from %v to %v, want Backlog to Todo", en.Seq, from, to)
		}
	}
	// One lapse, recorded by Darkory; one take-back, by kai.
	if l := tr.of(client.ActivityKindTaskLapsed, ""); len(l) != 1 || l[0].SubjectID != logs.Task.ID || l[0].ActorID != nil || l[0].Payload["holder_id"] != id("lapser") {
		t.Errorf("the lapses %+v", l)
	}
	if tb := tr.of(client.ActivityKindTaskTakenBack, ""); len(tb) != 1 || tb[0].SubjectID != deploy.Task.ID || tb[0].ActorID == nil ||
		*tb[0].ActorID != kai.id || tb[0].Payload["holder_id"] != id("stuck") {
		t.Errorf("the take-backs %+v", tb)
	}
	// The Break down's Tasks were all filed before it completed.
	bdDone := tr.one(client.ActivityKindTaskCompleted, checkout.Tasks[0].ID)
	for _, tk := range []client.Task{api, screen, review, qa, help, demo, polish} {
		if f := tr.one(client.ActivityKindTaskFiled, tk.ID); f.Seq > bdDone.Seq || f.ActorID == nil || *f.ActorID != id("planner") {
			t.Errorf("%s was filed at seq %d, after the Break down completed at %d, or not by the planner", tk.Key, f.Seq, bdDone.Seq)
		}
	}
	// The question was filed and blocked the screen in one write, inside the builder's one Claim
	// on the screen, and answered before that Claim completed.
	qFiled := tr.one(client.ActivityKindTaskFiled, question.ID)
	if next := tr.at(qFiled.Seq + 1); next.Kind != client.ActivityKindTaskBlockerAdded || next.SubjectID != screen.ID ||
		next.Payload["blocker_id"] != question.ID || qFiled.Payload["aimed_at_id"] != mai.id || qFiled.Payload["blocks"] != screen.ID {
		t.Errorf("the question filed at seq %d %+v, then %+v", qFiled.Seq, qFiled, next)
	}
	screenClaim, screenDone := tr.one(client.ActivityKindTaskClaimed, screen.ID), tr.one(client.ActivityKindTaskCompleted, screen.ID)
	qDone := tr.one(client.ActivityKindTaskCompleted, question.ID)
	if !(screenClaim.Seq < qFiled.Seq && qFiled.Seq < qDone.Seq && qDone.Seq < screenDone.Seq) || screenDone.Payload["claim_id"] != screenClaim.Payload["claim_id"] {
		t.Errorf("the screen claimed at %d, its question filed at %d and answered at %d, the screen completed at %d", screenClaim.Seq, qFiled.Seq, qDone.Seq, screenDone.Seq)
	}
	// The API's Handover named In review; the reviewer then claimed and completed it.
	ho := tr.one(client.ActivityKindTaskHandedOver, api.ID)
	if ho.Payload["status_id"] != inReview.ID || ho.Payload["from_status_id"] != inProgress.ID {
		t.Errorf("the API's Handover %+v", ho)
	}
	if cl := tr.of(client.ActivityKindTaskClaimed, api.ID); len(cl) != 2 || cl[1].Seq < ho.Seq || *cl[1].ActorID != id("reviewer") {
		t.Errorf("the API's claims %+v after its Handover at %d", cl, ho.Seq)
	}
	// Review and QA were claimed only after both builds had ended.
	built := max(tr.one(client.ActivityKindTaskCompleted, api.ID).Seq, screenDone.Seq)
	for _, tk := range []client.Task{review, qa} {
		if cl := tr.of(client.ActivityKindTaskClaimed, tk.ID); len(cl) == 0 || cl[0].Seq < built {
			t.Errorf("%s was claimed at %+v, before both builds ended at %d", tk.Key, cl, built)
		}
	}
	// The ship came after every Task's end, and filed the Retrospective in the same write.
	ships := tr.of(client.ActivityKindFeatureShipped, "")
	if len(ships) != 1 || ships[0].SubjectID != checkout.Feature.ID {
		t.Fatalf("the ships %+v", ships)
	}
	if next := tr.at(ships[0].Seq + 1); next.Kind != client.ActivityKindTaskFiled || next.SubjectID != retro.ID || next.Payload["kind"] != "retrospective" {
		t.Errorf("after the ship at %d: %+v", ships[0].Seq, next)
	}
	for _, tk := range []client.Task{api, screen, review, qa, help} {
		if e := tr.one(client.ActivityKindTaskCompleted, tk.ID); e.Seq > ships[0].Seq {
			t.Errorf("%s completed at %d, after the ship at %d", tk.Key, e.Seq, ships[0].Seq)
		}
	}
	for _, tk := range []client.Task{demo, polish} {
		if e := tr.one(client.ActivityKindTaskDropped, tk.ID); e.Seq > ships[0].Seq || e.ActorID == nil || *e.ActorID != kai.id {
			t.Errorf("%s dropped %+v, after the ship at %d or not by kai", tk.Key, e, ships[0].Seq)
		}
	}
	// The proposal, its Handover to skill-review, the reviewer's claim, and the completion that
	// published version 2 in the same write.
	proposed := tr.one(client.ActivityKindTaskSkillProposed, retro.ID)
	retroHo := tr.one(client.ActivityKindTaskHandedOver, retro.ID)
	retroClaims := tr.of(client.ActivityKindTaskClaimed, retro.ID)
	retroDone := tr.one(client.ActivityKindTaskCompleted, retro.ID)
	published := tr.at(retroDone.Seq + 1)
	if *proposed.ActorID != id("retro") || len(retroClaims) != 2 || *retroClaims[1].ActorID != id("reviewer") ||
		!(proposed.Seq < retroHo.Seq && retroHo.Seq < retroClaims[1].Seq && retroClaims[1].Seq < retroDone.Seq) ||
		published.Kind != client.ActivityKindSkillVersionPublished || published.Payload["version"] != float64(2) || published.Payload["task_id"] != retro.ID {
		t.Errorf("the Retrospective: proposed %+v, handed over %+v, claimed %+v, completed %+v, then %+v", proposed, retroHo, retroClaims, retroDone, published)
	}
}

// botLog collects what the bots report, logging all but the prober's empty answers.
type botLog struct {
	t      *testing.T
	mu     sync.Mutex
	events []bot.Event
}

func (l *botLog) add(e bot.Event) {
	l.mu.Lock()
	l.events = append(l.events, e)
	l.mu.Unlock()
	if e.What != "nothing" {
		l.t.Log(e)
	}
}

// find returns, in order, what the bot name reported as what; an empty name or what matches any.
func (l *botLog) find(name, what string) []bot.Event {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []bot.Event
	for _, e := range l.events {
		if (name == "" || e.Bot == name) && (what == "" || e.What == what) {
			out = append(out, e)
		}
	}
	return out
}

// wait waits for the bot name (any, when empty) to report what about task, and returns the
// first such report.
func (l *botLog) wait(within time.Duration, name, what, task string) bot.Event {
	l.t.Helper()
	var found bot.Event
	eventually(l.t, within, fmt.Sprintf("%s reporting %s %s", or(name, "a bot"), what, task), func() bool {
		for _, e := range l.find(name, what) {
			if e.Task == task {
				found = e
				return true
			}
		}
		return false
	})
	return found
}

func or(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

// human gives a human Member an admin created a token, and a Session of their own.
func (in *install) human(name string) *member {
	in.t.Helper()
	var tok client.IssuedToken
	in.ada.json(&tok, "token", "issue", name, "--name", name)
	m := &member{in: in, name: name, token: tok.Secret, url: in.servers[0].url}
	m.session = m.prime()
	var me client.Me
	m.json(&me, "me")
	m.id = me.Member.ID
	return m
}

// api reads the record through the generated client as one Member, failing the test on any error.
type api struct {
	t *testing.T
	c *client.ClientWithResponses
}

func dialAs(t *testing.T, url string, m *member) api {
	t.Helper()
	c, err := bot.Dial(url, nil, bot.Member{Name: m.name, Token: m.token, Session: m.session})
	if err != nil {
		t.Fatal(err)
	}
	return api{t, c}
}

func (a api) task(key string) client.TaskDetail {
	a.t.Helper()
	res, err := a.c.GetTaskWithResponse(context.Background(), key)
	if err != nil || res.JSON200 == nil {
		a.t.Fatalf("reading %s: %v %s", key, err, bodyOf(res))
	}
	return *res.JSON200
}

func (a api) feature(key string) client.FeatureDetail {
	a.t.Helper()
	res, err := a.c.GetFeatureWithResponse(context.Background(), key)
	if err != nil || res.JSON200 == nil {
		a.t.Fatalf("reading %s: %v %s", key, err, bodyOf(res))
	}
	return *res.JSON200
}

func (a api) statuses() []client.Status {
	a.t.Helper()
	res, err := a.c.ListStatusesWithResponse(context.Background())
	if err != nil || res.JSON200 == nil {
		a.t.Fatalf("listing Statuses: %v %s", err, bodyOf(res))
	}
	return res.JSON200.Items
}

// tasks lists every Task matching p, page by page.
func (a api) tasks(p client.ListTasksParams) []client.Task {
	a.t.Helper()
	p.Limit = ptr(500)
	var out []client.Task
	for {
		res, err := a.c.ListTasksWithResponse(context.Background(), &p)
		if err != nil || res.JSON200 == nil {
			a.t.Fatalf("listing Tasks: %v %s", err, bodyOf(res))
		}
		out = append(out, res.JSON200.Items...)
		if res.JSON200.NextCursor == nil {
			return out
		}
		p.Cursor = res.JSON200.NextCursor
	}
}

// inProgress finds the Task key among the Tasks GET /v1/tasks lists In progress.
func (a api) inProgress(key string) client.Task {
	a.t.Helper()
	for _, tk := range a.tasks(client.ListTasksParams{Status: ptr("In progress")}) {
		if tk.Key == key {
			if tk.Claim == nil || tk.Claim.ExpiresAt == nil {
				a.t.Fatalf("%s is listed In progress with Claim %+v", key, tk.Claim)
			}
			return tk
		}
	}
	a.t.Fatalf("%s is not listed In progress", key)
	return client.Task{}
}

func (a api) takeable() []string {
	a.t.Helper()
	res, err := a.c.ListTakeableTasksWithResponse(context.Background(), &client.ListTakeableTasksParams{})
	if err != nil || res.JSON200 == nil {
		a.t.Fatalf("listing takeable Tasks: %v %s", err, bodyOf(res))
	}
	var keys []string
	for _, tk := range res.JSON200.Items {
		keys = append(keys, tk.Key)
	}
	return keys
}

// activity reads the whole Activity trail, oldest first.
func (a api) activity() []client.Activity {
	a.t.Helper()
	var out []client.Activity
	var after int64
	for {
		res, err := a.c.ListActivityWithResponse(context.Background(), &client.ListActivityParams{After: &after, Limit: ptr(500)})
		if err != nil || res.JSON200 == nil {
			a.t.Fatalf("reading Activity after %d: %v %s", after, err, bodyOf(res))
		}
		if len(res.JSON200.Items) == 0 {
			return out
		}
		out = append(out, res.JSON200.Items...)
		after = res.JSON200.LastSeq
	}
}

// orgShape lists the Organisation's Teams with their defaults and Members, its Workspaces, its
// Statuses in order, its Members with their kind, manager and Skills, and its Skills with their
// versions, sorted, to compare one Setup with the next.
func orgShape(a api) []string {
	a.t.Helper()
	ctx := context.Background()
	var out []string
	teams, err := a.c.ListTeamsWithResponse(ctx)
	if err != nil || teams.JSON200 == nil {
		a.t.Fatalf("listing Teams: %v %s", err, bodyOf(teams))
	}
	for _, tm := range teams.JSON200.Items {
		res, err := a.c.GetTeamWithResponse(ctx, tm.Key)
		if err != nil || res.JSON200 == nil {
			a.t.Fatalf("reading %s: %v %s", tm.Key, err, bodyOf(res))
		}
		var names []string
		for _, m := range res.JSON200.Members {
			names = append(names, m.Name)
		}
		sort.Strings(names)
		out = append(out, fmt.Sprintf("team %s %s default=%s ship_when_done=%v: %s", tm.Key, tm.Name, deref(tm.DefaultWorkspaceID), tm.ShipWhenDone,
			strings.Join(names, " ")))
	}
	workspaces, err := a.c.ListWorkspacesWithResponse(ctx)
	if err != nil || workspaces.JSON200 == nil {
		a.t.Fatalf("listing Workspaces: %v %s", err, bodyOf(workspaces))
	}
	for _, w := range workspaces.JSON200.Items {
		out = append(out, fmt.Sprintf("workspace %s %s %s %s %s", w.ID, w.Name, w.Kind, w.Path, w.DefaultBranch))
	}
	for _, s := range a.statuses() {
		out = append(out, fmt.Sprintf("status %d %s %s %s", s.Position, s.ID, s.Name, s.Kind))
	}
	members, err := a.c.ListMembersWithResponse(ctx, &client.ListMembersParams{})
	if err != nil || members.JSON200 == nil {
		a.t.Fatalf("listing Members: %v %s", err, bodyOf(members))
	}
	for _, m := range members.JSON200.Items {
		res, err := a.c.GetMemberWithResponse(ctx, m.ID)
		if err != nil || res.JSON200 == nil {
			a.t.Fatalf("reading %s: %v %s", m.Name, err, bodyOf(res))
		}
		var skills []string
		for _, s := range res.JSON200.Skills {
			skills = append(skills, s.Name)
		}
		sort.Strings(skills)
		out = append(out, fmt.Sprintf("member %s %s admin=%v manager=%v deactivated=%v: %s", m.Name, m.Kind, m.Admin,
			deref(m.ManagerID), m.DeactivatedAt != nil, strings.Join(skills, " ")))
	}
	skills, err := a.c.ListSkillsWithResponse(ctx, &client.ListSkillsParams{})
	if err != nil || skills.JSON200 == nil {
		a.t.Fatalf("listing Skills: %v %s", err, bodyOf(skills))
	}
	for _, s := range skills.JSON200.Items {
		out = append(out, fmt.Sprintf("skill %s %s v%d", s.Name, s.Kind, s.CurrentVersion))
	}
	sort.Strings(out)
	return out
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}

// replay follows each Task's Status through the Activity alone, by the rules of ADR 0012, and
// fails the test where an entry disagrees with it, such as a claim of a Task in a Backlog Status.
// It returns each Task's predicted Status, and the kind of the Status it was last filed into or
// moved to by a Member.
func replay(t *testing.T, trail []client.Activity, statuses []client.Status) (map[string]string, map[string]client.StatusKind) {
	t.Helper()
	kind := map[string]client.StatusKind{}
	first := map[client.StatusKind]string{}
	for _, s := range statuses {
		kind[s.ID] = s.Kind
		if _, ok := first[s.Kind]; !ok {
			first[s.Kind] = s.ID
		}
	}
	status := map[string]string{}
	named := map[string]client.StatusKind{}
	str := func(en client.Activity, k string) string { s, _ := en.Payload[k].(string); return s }
	// release is a Claim ending other than by Handover, Complete or Drop.
	release := func(task string) {
		if kind[status[task]] == client.StatusKindInProgress {
			status[task] = first[client.StatusKindTodo]
		}
	}
	for i, en := range trail {
		task := en.SubjectID
		switch en.Kind {
		case client.ActivityKindTaskFiled:
			status[task] = str(en, "status_id")
			named[task] = kind[status[task]]
		case client.ActivityKindTaskStatusSet:
			if en.ActorID == nil || str(en, "from") != status[task] {
				t.Errorf("seq %d: %+v moves from %s, by %v", en.Seq, en, status[task], en.ActorID)
			}
			status[task] = str(en, "to")
			named[task] = kind[status[task]]
		case client.ActivityKindTaskClaimed:
			switch kind[status[task]] {
			case client.StatusKindTodo:
				status[task] = first[client.StatusKindInProgress]
			case client.StatusKindInProgress:
			default:
				t.Errorf("seq %d: %s claimed while in %s", en.Seq, task, kind[status[task]])
			}
		case client.ActivityKindTaskLapsed:
			// A lapse the next claim records in its own batch, just before its own entry and at its
			// time, leaves the Status where it was (decisions.md).
			if n := i + 1; n < len(trail) && trail[n].Kind == client.ActivityKindTaskClaimed && trail[n].SubjectID == task && trail[n].At.Equal(en.At) {
				continue
			}
			release(task)
		case client.ActivityKindTaskReleased, client.ActivityKindTaskTakenBack, client.ActivityKindTaskClaimEnded:
			release(task)
		case client.ActivityKindTaskHandedOver:
			if to := str(en, "status_id"); to != "" {
				if str(en, "from_status_id") != status[task] {
					t.Errorf("seq %d: a Handover from %s, but the Task was in %s", en.Seq, str(en, "from_status_id"), status[task])
				}
				status[task] = to
			}
		case client.ActivityKindTaskCompleted:
			status[task] = first[client.StatusKindDone]
		case client.ActivityKindTaskDropped:
			status[task] = first[client.StatusKindDropped]
		case client.ActivityKindStatusesChanged:
			// A preset's Setup may set the Statuses before anything is filed.
			if len(status) > 0 {
				t.Errorf("seq %d: the Statuses changed during the run, which replay does not follow", en.Seq)
			}
		}
	}
	return status, named
}

// trail is the whole Activity, oldest first, numbered from 1.
type trail struct {
	t       *testing.T
	entries []client.Activity
}

// trailOf checks the numbers run 1, 2, 3… with no gap, and each kind is about its subject type.
func trailOf(t *testing.T, entries []client.Activity) trail {
	t.Helper()
	for i, en := range entries {
		if en.Seq != int64(i+1) {
			t.Fatalf("Activity entry %d has seq %d", i+1, en.Seq)
		}
		if area, _, _ := strings.Cut(string(en.Kind), "."); area != string(en.SubjectType) {
			t.Errorf("seq %d: %s about a %s", en.Seq, en.Kind, en.SubjectType)
		}
	}
	return trail{t, entries}
}

func (tr trail) at(seq int64) client.Activity {
	if seq < 1 || seq > int64(len(tr.entries)) {
		return client.Activity{}
	}
	return tr.entries[seq-1]
}

// of returns the entries of kind about subject (any, when empty), in order.
func (tr trail) of(kind client.ActivityKind, subject string) []client.Activity {
	var out []client.Activity
	for _, en := range tr.entries {
		if en.Kind == kind && (subject == "" || en.SubjectID == subject) {
			out = append(out, en)
		}
	}
	return out
}

// one returns the only entry of kind about subject.
func (tr trail) one(kind client.ActivityKind, subject string) client.Activity {
	tr.t.Helper()
	es := tr.of(kind, subject)
	if len(es) != 1 {
		tr.t.Fatalf("%d %s entries about %s, want 1: %+v", len(es), kind, subject, es)
	}
	return es[0]
}

// checkClaims checks that every claim is followed by exactly one end of that Claim before the
// Task is claimed again, and that every agent bot's claims carry its model label.
func (tr trail) checkClaims(crew *bot.Crew) {
	tr.t.Helper()
	model := map[string]string{}
	for _, s := range crew.Preset.Agents {
		model[crew.Members[s.Name].ID] = s.Model
	}
	ends := []client.ActivityKind{client.ActivityKindTaskReleased, client.ActivityKindTaskHandedOver, client.ActivityKindTaskCompleted,
		client.ActivityKindTaskLapsed, client.ActivityKindTaskTakenBack, client.ActivityKindTaskDropped, client.ActivityKindTaskClaimEnded}
	live := map[string]string{} // Task → the claim open on it
	for _, en := range tr.entries {
		claim, _ := en.Payload["claim_id"].(string)
		switch {
		case en.Kind == client.ActivityKindTaskClaimed:
			if open := live[en.SubjectID]; open != "" {
				tr.t.Errorf("seq %d: %s claimed while Claim %s was open", en.Seq, en.SubjectID, open)
			}
			live[en.SubjectID] = claim
			if want, ok := model[*en.ActorID]; ok && en.Payload["model_label"] != want {
				tr.t.Errorf("seq %d: a bot claimed with the model label %v, want %s", en.Seq, en.Payload["model_label"], want)
			}
		case slices.Contains(ends, en.Kind) && claim != "":
			if live[en.SubjectID] != claim {
				tr.t.Errorf("seq %d: %s ends Claim %s, but the open one is %q", en.Seq, en.Kind, claim, live[en.SubjectID])
			}
			delete(live, en.SubjectID)
		}
	}
	for task, claim := range live {
		tr.t.Errorf("Claim %s on %s never ended", claim, task)
	}
}
