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

// The bots of tools/bots/bot work as the agent Members of a fresh Install with two Projects, while
// the test acts as its three humans: ada the admin, kai who owns the Task and directs the agents,
// and mai who answers their question. As they work, the test checks that:
//
//   - Setup is idempotent: run again, it changes nothing but the tokens.
//   - A Claim leaves its Task at its Step, and GET /v1/tasks shows the holder and Heartbeat.
//   - The lapser's Claim lapses, Darkory records it with no actor, and its Task waits at its Step.
//   - kai takes back the stuck agent's Task: it waits at its Step and the agent's CLI exits 3.
//   - next never offers a Task in the Backlog hold: the prober gets nothing until mai moves one to
//     Docs, then exactly that one, and no Task is ever held while at the hold.
//   - A builder's question aimed at mai lands beside its Task under the same Parent, blocks it and
//     is mai's to take; completing it unblocks the Task, which the builder held throughout.
//   - A build is advanced along "pass" to Review, and the reviewer advances it into Done.
//   - The Parent cannot be completed while Subtasks are open, and is once they have ended.
//   - The Retrospective's proposal is published as version 2 by the reviewer.
//
// Then, with the bots stopped, every Task is at exactly one Step or none, as its state, its Claims
// and a replay of its Activity say, and the whole trail is gapless and in the order the scenarios
// imply.
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
	opts := bot.Options{Project: "WEB", ProjectName: "Web", Ops: "OPS", OpsName: "Ops", Manager: "kai", Ask: "mai",
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
	web, ops := admin.workflow("WEB"), admin.workflow("OPS")
	for _, wf := range []client.Workflow{web, ops} {
		if names := stepNamesOf(wf); !slices.Equal(names, specStepNames(bot.SoftwareWorkflow)) {
			t.Fatalf("a Project's Workflow is %v", names)
		}
	}
	step := func(wf client.Workflow, name string) client.WorkflowStep {
		for _, s := range wf.Steps {
			if s.Name == name {
				return s
			}
		}
		t.Fatalf("no Step %s in %s's Workflow", name, wf.ProjectID)
		return client.WorkflowStep{}
	}
	backlog, build, docs, qaStep, reviewStep := step(web, bot.StepBacklog), step(web, bot.StepBuild), step(web, bot.StepDocs),
		step(web, bot.StepQA), step(web, bot.StepReview)
	triage, deployStep := step(ops, bot.StepTriage), step(ops, bot.StepDeploy)

	// The bots start, and a watcher looks for a Task held at the Backlog hold, which must never be.
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
		for sleepCtx(runCtx, 100*time.Millisecond) {
			res, err := admin.c.ListTasksWithResponse(runCtx, &client.ListTasksParams{Step: &backlog.ID, Limit: ptr(500)})
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

	// kai files Checkout with Break down; ada files the chores the lapser and stuck take.
	var checkout client.TaskDetail
	kai.json(&checkout, "file", "--project", "WEB", "--title", "Checkout", "--body", "Customers pay for their basket.", "--breakdown")
	pkey, bdKey := checkout.Task.Key, checkout.Subtasks[0].Key
	var logs, deploy client.TaskDetail
	ada.json(&logs, "file", "--project", "OPS", "--title", "Rotate the logs", "--step", bot.StepTriage)
	ada.json(&deploy, "file", "--project", "OPS", "--title", "Deploy to staging", "--step", bot.StepDeploy)

	// The lapser claims with a 2 s timeout and exits; the sweeper records the lapse.
	rec.wait(20*time.Second, "lapser", "went silent", logs.Task.Key)
	eventually(t, 15*time.Second, "the lapser exiting", func() bool { return exited("lapser") })
	eventually(t, 15*time.Second, "the lapse recorded", func() bool {
		return len(admin.trailOfKind(client.ActivityKindTaskLapsed, logs.Task.ID)) == 1
	})
	// GET /v1/tasks/{task} then shows it waiting at Triage, with the lapse recorded.
	if d := admin.task(logs.Task.Key); len(d.Claims) != 1 || *d.Claims[0].HowEnded != client.ClaimEndLapsed || d.Claims[0].HolderID != id("lapser") ||
		d.Task.Claim != nil || d.Step == nil || d.Step.ID != triage.ID || deref(d.Task.StepID) != triage.ID {
		t.Fatalf("the lapser's Task is at %s with Claims %+v", where(d), d.Claims)
	}

	// stuck holds its Task through the real CLI; GET /v1/tasks shows it at Deploy, held, with a
	// Heartbeat that keeps moving its expiry.
	rec.wait(20*time.Second, "stuck", "heartbeating", deploy.Task.Key)
	held := admin.held(deployStep.ID, deploy.Task.Key)
	if c := held.Claim; c.HolderID != id("stuck") || c.HeartbeatTimeoutSeconds == nil || *c.HeartbeatTimeoutSeconds != bot.Fast.Timeout ||
		c.ModelLabel == nil || !c.ExpiresAt.After(time.Now()) {
		t.Fatalf("stuck's Claim as listed %+v", c)
	}
	time.Sleep(time.Duration(2*bot.Fast.Timeout+1) * time.Second)
	if later := admin.held(deployStep.ID, deploy.Task.Key); later.Claim.ID != held.Claim.ID || !later.Claim.ExpiresAt.After(*held.Claim.ExpiresAt) {
		t.Fatalf("stuck's Claim was not kept alive: %+v, then %+v", held.Claim, later.Claim)
	}
	// kai, whom stuck reports to, takes it back; stuck's `darkory heartbeat` exits 3.
	kai.ok("take-back", deploy.Task.Key, "--reason", "it has been deploying for too long")
	tb := rec.wait(15*time.Second, "stuck", "taken back", deploy.Task.Key)
	if tb.Code != 3 || !strings.Contains(tb.Text, "was taken back") {
		t.Fatalf("stuck reported %s", tb)
	}
	eventually(t, 15*time.Second, "stuck stopping", func() bool { return exited("stuck") })
	if d := admin.task(deploy.Task.Key); d.Task.Claim != nil || deref(d.Task.StepID) != deployStep.ID || len(d.Claims) != 1 ||
		*d.Claims[0].HowEnded != client.ClaimEndTakenBack {
		t.Fatalf("after the take-back the Task is at %s with Claims %+v", where(d), d.Claims)
	}

	// The planner breaks Checkout down; it cannot be completed while its Subtasks are open.
	planned := rec.wait(30*time.Second, "planner", "completed", bdKey)
	checkout = admin.task(pkey)
	task := map[string]client.Task{}
	for _, tk := range checkout.Subtasks {
		task[strings.TrimSuffix(tk.Title, " Checkout")] = tk
	}
	api, screen, qa := task["Build the API for"], task["Build the screen for"], task["QA"]
	help, demo, polish := task["Write the help page for"], task["Record a demo of"], task["Polish"]
	for name, tk := range map[string]client.Task{"api": api, "screen": screen, "qa": qa, "help": help, "demo": demo, "polish": polish} {
		if tk.Key == "" {
			t.Fatalf("the planner filed no %s Subtask: %+v", name, checkout.Subtasks)
		}
	}
	if bd := admin.task(bdKey); bd.Task.State != client.TaskStateDone || bd.Claims[0].HolderID != id("planner") ||
		!strings.HasPrefix(bd.Notes[len(bd.Notes)-1].Body, "Filed 6 Subtasks") {
		t.Fatalf("the Breakdown %+v with Notes %+v", bd.Task, bd.Notes)
	}
	if checkout.Task.StepID != nil || checkout.Task.SubtaskCounts == nil {
		t.Fatalf("Checkout is not a Parent: %+v", checkout.Task)
	}
	kai.refused(3, client.ErrorCodeTasksOpen, "complete", pkey)

	// The prober asks next again and again and gets nothing while its Subtasks wait in the
	// Backlog; mai moves the help page to Docs, and the prober gets exactly that.
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
		t.Fatalf("next offered the prober a Task in the Backlog: %s", took[0])
	}
	moved := time.Now()
	mai.ok("move", help.Key, bot.StepDocs)
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
	if question.Key == "" || deref(question.ParentID) != checkout.Task.ID || question.StepID != nil || !sd.Task.Blocked || sd.Task.Claim == nil ||
		sd.Task.Claim.HolderID != id(asker) || deref(sd.Task.StepID) != build.ID {
		t.Fatalf("while %s waits: %+v at %s, blocked by %+v", asker, sd.Task, where(sd), sd.Blockers)
	}
	if listed := admin.held(build.ID, screen.Key); !listed.Blocked || listed.Claim.HolderID != id(asker) || !listed.Claim.ExpiresAt.After(time.Now()) {
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
	mai.ok("claim", question.Key, "--timeout", "0")
	mai.ok("complete", question.Key, "--note", "Yes: signed-out customers pay as guests.")
	answered := rec.wait(15*time.Second, asker, "answered", screen.Key)
	if !strings.Contains(answered.Text, "pay as guests") {
		t.Fatalf("%s read the answer as %s", asker, answered)
	}
	if adv := rec.wait(15*time.Second, asker, "advanced", screen.Key); !strings.Contains(adv.Text, `along "pass", now at `+bot.StepReview) {
		t.Fatalf("the screen was advanced: %s", adv)
	}
	rec.wait(30*time.Second, "reviewer", "completed", screen.Key)
	sd = admin.task(screen.Key)
	if len(sd.Claims) != 2 || sd.Claims[0].ID != waiting || *sd.Claims[0].HowEnded != client.ClaimEndAdvanced ||
		sd.Claims[1].HolderID != id("reviewer") || *sd.Claims[1].HowEnded != client.ClaimEndCompleted ||
		len(sd.Observations) != 1 || sd.Observations[0].Outcome != client.DidntWork || sd.Observations[0].AuthorID != id(asker) ||
		len(sd.Evidence) != 1 || sd.Evidence[0].AttachedBy != id(asker) {
		t.Fatalf("the screen once reviewed: Claims %+v, Observations %+v, Evidence %+v", sd.Claims, sd.Observations, sd.Evidence)
	}

	// The API is advanced to Review, and the reviewer advances it into Done.
	advanced := rec.wait(30*time.Second, "", "advanced", api.Key)
	if !strings.Contains(advanced.Text, "now at "+bot.StepReview) {
		t.Fatalf("the API was advanced: %s", advanced)
	}
	rec.wait(30*time.Second, "reviewer", "completed", api.Key)
	if ad := admin.task(api.Key); len(ad.Claims) != 2 || ad.Claims[0].HolderID != id(advanced.Bot) || *ad.Claims[0].HowEnded != client.ClaimEndAdvanced ||
		ad.Claims[1].HolderID != id("reviewer") || *ad.Claims[1].HowEnded != client.ClaimEndCompleted || ad.Task.State != client.TaskStateDone ||
		ad.Task.StepID != nil {
		t.Fatalf("the API's Claims %+v, %s at %s", ad.Claims, ad.Task.State, where(ad))
	}

	// QA, unblocked once both builds are done, is worked; the Parent cannot be completed while the
	// demo and the polish wait in the Backlog, and is once kai drops them.
	rec.wait(30*time.Second, "", "completed", qa.Key)
	kai.refused(3, client.ErrorCodeTasksOpen, "complete", pkey)
	kai.ok("drop", demo.Key, "--reason", "no release notes this time")
	kai.ok("drop", polish.Key, "--reason", "nothing worth a second pass")
	var completed client.Task
	kai.json(&completed, "complete", pkey)
	if completed.State != client.TaskStateDone {
		t.Fatalf("completed %+v", completed)
	}
	var retro client.Task
	for _, tk := range admin.task(pkey).Subtasks {
		if tk.Kind == client.Retrospective {
			retro = tk
		}
	}
	if retro.Key == "" {
		t.Fatalf("completing %s filed no Retrospective", pkey)
	}

	// retro proposes build-acme v2 from the builder's Observation; the reviewer publishes it.
	rec.wait(30*time.Second, "retro", "proposed", retro.Key)
	rec.wait(30*time.Second, "retro", "advanced", retro.Key)
	rec.wait(30*time.Second, "reviewer", "published", retro.Key)
	var v2 client.SkillDetail
	ada.json(&v2, "skill", "show", bot.SkillCompany)
	rd := admin.task(retro.Key)
	if v2.Skill.CurrentVersion != 2 || v2.Current.PublishedBy == nil || *v2.Current.PublishedBy != id("reviewer") ||
		!strings.Contains(v2.Current.Body, "From the Retrospective of "+pkey) || len(rd.Proposals) != 1 ||
		rd.Proposals[0].State != client.Published || rd.Proposals[0].AuthorID != id("retro") || rd.Task.State != client.TaskStateDone {
		t.Fatalf("%s is %+v; the Retrospective %+v with proposals %+v", bot.SkillCompany, v2, rd.Task, rd.Proposals)
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
	workflows := map[string]client.Workflow{web.ProjectID: web, ops.ProjectID: ops}
	predicted := replay(t, trail, workflows)
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
		atOneStep(t, d, workflows)
		if predicted[d.Task.ID] != deref(d.Task.StepID) {
			t.Errorf("%s is at %s, but its Activity puts it at %q", d.Task.Key, where(d), predicted[d.Task.ID])
		}
	}
	for _, k := range []string{demo.ID, polish.ID} {
		if d := tasks[k]; len(d.Claims) != 0 || d.Task.State != client.TaskStateDropped {
			t.Errorf("%s, filed into the Backlog and left there, is %s with Claims %+v", d.Task.Key, d.Task.State, d.Claims)
		}
	}

	tr := trailOf(t, trail)
	tr.checkClaims(crew)
	// The only moves Members made by hand: the planner moving QA out of the Backlog once its
	// blockers were set, and mai moving the help page.
	moves := tr.of(client.ActivityKindTaskMoved, "")
	if len(moves) != 2 {
		t.Errorf("%d task.moved entries, want 2: %+v", len(moves), moves)
	}
	for _, en := range moves {
		who := deref(en.ActorID)
		from, to := en.Payload["from"], en.Payload["to"]
		switch {
		case en.SubjectID == help.ID && who == mai.id && to == docs.ID:
		case en.SubjectID == qa.ID && who == id("planner") && to == qaStep.ID:
			if b := tr.of(client.ActivityKindTaskBlockerAdded, en.SubjectID); len(b) != 2 || b[1].Seq > en.Seq {
				t.Errorf("seq %d: the planner moved %s before both its blockers were set", en.Seq, en.SubjectID)
			}
		default:
			t.Errorf("seq %d: an unexpected move %+v", en.Seq, en)
		}
		if from != backlog.ID {
			t.Errorf("seq %d: a move from %v, want the Backlog", en.Seq, from)
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
	// The Breakdown's Subtasks were all filed by the planner before it completed.
	bdDone := tr.one(client.ActivityKindTaskCompleted, checkout.Subtasks[0].ID)
	for _, tk := range []client.Task{api, screen, qa, help, demo, polish} {
		if f := tr.one(client.ActivityKindTaskFiled, tk.ID); f.Seq > bdDone.Seq || f.ActorID == nil || *f.ActorID != id("planner") ||
			f.Payload["parent_id"] != checkout.Task.ID {
			t.Errorf("%s was filed at seq %d, after the Breakdown completed at %d, or not by the planner under %s", tk.Key, f.Seq, bdDone.Seq, pkey)
		}
	}
	// The question was filed beside the screen and blocked it in one write, inside the builder's
	// one Claim at Build, and answered before that Claim advanced the screen.
	qFiled := tr.one(client.ActivityKindTaskFiled, question.ID)
	if next := tr.at(qFiled.Seq + 1); next.Kind != client.ActivityKindTaskBlockerAdded || next.SubjectID != screen.ID ||
		next.Payload["blocker_id"] != question.ID || qFiled.Payload["aimed_at_id"] != mai.id || qFiled.Payload["blocks"] != screen.ID ||
		qFiled.Payload["parent_id"] != checkout.Task.ID {
		t.Errorf("the question filed at seq %d %+v, then %+v", qFiled.Seq, qFiled, next)
	}
	screenClaim, screenOn := tr.of(client.ActivityKindTaskClaimed, screen.ID)[0], tr.one(client.ActivityKindTaskAdvanced, screen.ID)
	qDone := tr.one(client.ActivityKindTaskCompleted, question.ID)
	if !(screenClaim.Seq < qFiled.Seq && qFiled.Seq < qDone.Seq && qDone.Seq < screenOn.Seq) || screenOn.Payload["claim_id"] != screenClaim.Payload["claim_id"] ||
		screenOn.Payload["from"] != build.ID || screenOn.Payload["to"] != reviewStep.ID || screenOn.Payload["outcome"] != "pass" {
		t.Errorf("the screen claimed at %d, its question filed at %d and answered at %d, the screen advanced %+v", screenClaim.Seq, qFiled.Seq, qDone.Seq, screenOn)
	}
	// The API was advanced from Build to Review; the reviewer then claimed it and advanced it into
	// Done along "pass".
	ho := tr.one(client.ActivityKindTaskAdvanced, api.ID)
	apiDone := tr.one(client.ActivityKindTaskCompleted, api.ID)
	if ho.Payload["from"] != build.ID || ho.Payload["to"] != reviewStep.ID || apiDone.Payload["from"] != reviewStep.ID || apiDone.Payload["outcome"] != "pass" {
		t.Errorf("the API advanced %+v and completed %+v", ho, apiDone)
	}
	if cl := tr.of(client.ActivityKindTaskClaimed, api.ID); len(cl) != 2 || cl[1].Seq < ho.Seq || *cl[1].ActorID != id("reviewer") {
		t.Errorf("the API's claims %+v after it was advanced at %d", cl, ho.Seq)
	}
	// QA was claimed only after both builds had ended.
	built := max(apiDone.Seq, tr.one(client.ActivityKindTaskCompleted, screen.ID).Seq)
	if cl := tr.of(client.ActivityKindTaskClaimed, qa.ID); len(cl) == 0 || cl[0].Seq < built {
		t.Errorf("%s was claimed at %+v, before both builds ended at %d", qa.Key, cl, built)
	}
	// The Parent's completion came after every Subtask's end, by kai, and filed the Retrospective in
	// the same write.
	parentDone := tr.one(client.ActivityKindTaskCompleted, checkout.Task.ID)
	if parentDone.ActorID == nil || *parentDone.ActorID != kai.id {
		t.Errorf("the Parent's completion %+v", parentDone)
	}
	if next := tr.at(parentDone.Seq + 1); next.Kind != client.ActivityKindTaskFiled || next.SubjectID != retro.ID || next.Payload["kind"] != "retrospective" ||
		next.ActorID != nil {
		t.Errorf("after the Parent's completion at %d: %+v", parentDone.Seq, next)
	}
	for _, tk := range []client.Task{api, screen, qa, help} {
		if e := tr.one(client.ActivityKindTaskCompleted, tk.ID); e.Seq > parentDone.Seq {
			t.Errorf("%s completed at %d, after its Parent at %d", tk.Key, e.Seq, parentDone.Seq)
		}
	}
	for _, tk := range []client.Task{demo, polish} {
		if e := tr.one(client.ActivityKindTaskDropped, tk.ID); e.Seq > parentDone.Seq || e.ActorID == nil || *e.ActorID != kai.id {
			t.Errorf("%s dropped %+v, after its Parent's completion at %d or not by kai", tk.Key, e, parentDone.Seq)
		}
	}
	// The proposal, the Retrospective advanced to Skill review, the reviewer's claim, and the
	// completion that published version 2 in the same write.
	proposed := tr.one(client.ActivityKindTaskSkillProposed, retro.ID)
	retroOn := tr.one(client.ActivityKindTaskAdvanced, retro.ID)
	retroClaims := tr.of(client.ActivityKindTaskClaimed, retro.ID)
	retroDone := tr.one(client.ActivityKindTaskCompleted, retro.ID)
	published := tr.at(retroDone.Seq + 1)
	if *proposed.ActorID != id("retro") || retroOn.Payload["outcome"] != "propose" || len(retroClaims) != 2 || *retroClaims[1].ActorID != id("reviewer") ||
		!(proposed.Seq < retroOn.Seq && retroOn.Seq < retroClaims[1].Seq && retroClaims[1].Seq < retroDone.Seq) ||
		published.Kind != client.ActivityKindSkillVersionPublished || published.Payload["version"] != float64(2) || published.Payload["task_id"] != retro.ID {
		t.Errorf("the Retrospective: proposed %+v, advanced %+v, claimed %+v, completed %+v, then %+v", proposed, retroOn, retroClaims, retroDone, published)
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

// workflow reads a Project's Workflow.
func (a api) workflow(project string) client.Workflow {
	a.t.Helper()
	res, err := a.c.GetWorkflowWithResponse(context.Background(), project)
	if err != nil || res.JSON200 == nil {
		a.t.Fatalf("reading %s's Workflow: %v %s", project, err, bodyOf(res))
	}
	return *res.JSON200
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

// held finds the Task key among the Tasks GET /v1/tasks lists at the Step step, held.
func (a api) held(step, key string) client.Task {
	a.t.Helper()
	for _, tk := range a.tasks(client.ListTasksParams{Step: &step}) {
		if tk.Key == key {
			if tk.Claim == nil || tk.Claim.ExpiresAt == nil {
				a.t.Fatalf("%s is listed at its Step with Claim %+v", key, tk.Claim)
			}
			return tk
		}
	}
	a.t.Fatalf("%s is not listed at the Step %s", key, step)
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

// trailOfKind is the Activity entries of kind about subject, oldest first.
func (a api) trailOfKind(kind client.ActivityKind, subject string) []client.Activity {
	var out []client.Activity
	for _, en := range a.activity() {
		if en.Kind == kind && en.SubjectID == subject {
			out = append(out, en)
		}
	}
	return out
}

// orgShape lists the Organisation's Projects with their defaults, Members and Workflows, its
// Workspaces, its Members with their kind, manager and Skills, and its Skills with their versions,
// sorted, to compare one Setup with the next.
func orgShape(a api) []string {
	a.t.Helper()
	ctx := context.Background()
	var out []string
	projects, err := a.c.ListProjectsWithResponse(ctx)
	if err != nil || projects.JSON200 == nil {
		a.t.Fatalf("listing Projects: %v %s", err, bodyOf(projects))
	}
	for _, p := range projects.JSON200.Items {
		res, err := a.c.GetProjectWithResponse(ctx, p.Key)
		if err != nil || res.JSON200 == nil {
			a.t.Fatalf("reading %s: %v %s", p.Key, err, bodyOf(res))
		}
		var names []string
		for _, m := range res.JSON200.Members {
			names = append(names, m.Name)
		}
		sort.Strings(names)
		out = append(out, fmt.Sprintf("project %s %s default=%s auto_complete=%v acceptance=%v: %s", p.Key, p.Name, deref(p.DefaultWorkspaceID),
			p.AutoComplete, p.Acceptance, strings.Join(names, " ")))
		wf := a.workflow(p.Key)
		for _, s := range wf.Steps {
			out = append(out, fmt.Sprintf("step %s %d %s %s %s", p.Key, s.Position, s.ID, s.Name, deref(s.SkillID)))
		}
		for _, k := range wf.Connectors {
			out = append(out, fmt.Sprintf("connector %s %s %s %s %s %d", p.Key, k.ID, k.FromStepID, deref(k.ToStepID), k.Name, k.Position))
		}
	}
	workspaces, err := a.c.ListWorkspacesWithResponse(ctx)
	if err != nil || workspaces.JSON200 == nil {
		a.t.Fatalf("listing Workspaces: %v %s", err, bodyOf(workspaces))
	}
	for _, w := range workspaces.JSON200.Items {
		out = append(out, fmt.Sprintf("workspace %s %s %s %s %s", w.ID, w.Name, w.Kind, w.Path, w.DefaultBranch))
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

// stepNamesOf are a Workflow's Steps' names, in order; specStepNames a preset's.
func stepNamesOf(wf client.Workflow) []string {
	var out []string
	for _, s := range wf.Steps {
		out = append(out, s.Name)
	}
	return out
}

func specStepNames(w bot.WorkflowSpec) []string {
	var out []string
	for _, s := range w.Steps {
		out = append(out, s.Name)
	}
	return out
}

// where names the Step a Task is at, for messages.
func where(d client.TaskDetail) string {
	if d.Step == nil {
		return "no Step"
	}
	return d.Step.Name
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

// atOneStep checks the invariant that a Task is at exactly one Step or none: an open Task that
// is not a Parent and not aimed at a Member is at one Step of its Project's Workflow; any other
// Task is at none.
func atOneStep(t *testing.T, d client.TaskDetail, workflows map[string]client.Workflow) {
	t.Helper()
	tk := d.Task
	wantNone := tk.State != client.TaskStateOpen || tk.SubtaskCounts != nil || tk.AimedAtID != nil
	switch {
	case wantNone && tk.StepID != nil:
		t.Errorf("%s (%s, Parent %v, aimed %v) is at the Step %s; it should be at none", tk.Key, tk.State, tk.SubtaskCounts != nil, tk.AimedAtID != nil, *tk.StepID)
	case !wantNone && tk.StepID == nil:
		t.Errorf("%s is open, worked and at no Step", tk.Key)
	case tk.StepID != nil:
		wf, ok := workflows[tk.ProjectID]
		if ok && !slices.ContainsFunc(wf.Steps, func(s client.WorkflowStep) bool { return s.ID == *tk.StepID }) {
			t.Errorf("%s is at %s, which is no Step of its Project's Workflow", tk.Key, *tk.StepID)
		}
		if d.Step == nil || d.Step.ID != *tk.StepID {
			t.Errorf("%s is at %s, and its detail shows %+v", tk.Key, *tk.StepID, d.Step)
		}
	}
}

// replay follows each Task's Step through the Activity alone, by ADR 0016, and fails the test
// where an entry disagrees with it, such as a claim of a Task at a hold or an advance from a Step
// it is not at. It returns each Task's predicted Step, "" for none.
func replay(t *testing.T, trail []client.Activity, workflows map[string]client.Workflow) map[string]string {
	t.Helper()
	skill := map[string]string{} // Step id → its Skill's id, "" at a hold
	for _, wf := range workflows {
		for _, s := range wf.Steps {
			skill[s.ID] = deref(s.SkillID)
		}
	}
	step := map[string]string{}
	filed := false
	str := func(en client.Activity, k string) string { s, _ := en.Payload[k].(string); return s }
	from := func(en client.Activity) {
		if f, ok := en.Payload["from"].(string); ok && f != step[en.SubjectID] {
			t.Errorf("seq %d: %s from %s, but the Task was at %q", en.Seq, en.Kind, f, step[en.SubjectID])
		}
	}
	for _, en := range trail {
		task := en.SubjectID
		switch en.Kind {
		case client.ActivityKindTaskFiled:
			filed = true
			step[task] = str(en, "step_id")
		case client.ActivityKindTaskMoved:
			if en.ActorID == nil && en.Payload["workflow_changed"] == nil {
				t.Errorf("seq %d: a move by nobody %+v", en.Seq, en)
			}
			from(en)
			step[task] = str(en, "to")
		case client.ActivityKindTaskAdvanced:
			from(en)
			step[task] = str(en, "to")
		case client.ActivityKindTaskClaimed:
			if s, at := step[task], step[task] != ""; at && skill[s] == "" {
				t.Errorf("seq %d: %s claimed while at the hold %s", en.Seq, task, s)
			}
		case client.ActivityKindTaskCompleted, client.ActivityKindTaskDropped, client.ActivityKindTaskBecameParent:
			from(en)
			step[task] = ""
		case client.ActivityKindWorkflowChanged:
			// A preset's Setup sets the Workflows before anything is filed.
			if filed {
				t.Errorf("seq %d: a Workflow changed during the run, which replay does not follow", en.Seq)
			}
		}
	}
	return step
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
	ends := []client.ActivityKind{client.ActivityKindTaskReleased, client.ActivityKindTaskAdvanced, client.ActivityKindTaskCompleted,
		client.ActivityKindTaskLapsed, client.ActivityKindTaskTakenBack, client.ActivityKindTaskDropped, client.ActivityKindTaskClaimEnded,
		client.ActivityKindTaskSplit}
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
