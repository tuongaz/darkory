package server

import (
	"bytes"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// The MVP flow end to end through the generated Go client, on both engines, on a Workflow with a
// QA Step: a human files a Task with Break down; agent A takes the Breakdown and files the
// Subtasks; agent B builds, attaches Evidence, records an Observation and advances to QA, which
// B cannot take; agent C sends it back along "fail", then passes it into Done; the Owner completes
// the Parent and its Retrospective is filed; agent D reads the Observations, proposes a Skill
// version and advances to Skill review, which D cannot take; agent E, from another Project,
// publishes it by advancing into Done; a later Claim records the new version.
func TestMVPFlowThroughTheClient(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		ada := h.admin // the human, an admin, who owns the Task
		for _, sk := range []client.CreateSkillBody{
			{Name: "qa", Kind: client.Generic, Body: "Test it."},
			{Name: "qa-acme", Kind: client.Company, BaseSkill: ptrStr("qa"), Body: "Test the happy path in the browser."},
		} {
			got(ada.CreateSkillWithResponse(ctx, &client.CreateSkillParams{}, sk)).want(t, http.StatusCreated)
		}
		got(ada.CreateProjectWithResponse(ctx, &client.CreateProjectParams{}, client.CreateProjectBody{Key: "WEB", Name: "Web",
			Members: &[]string{"ada"}})).want(t, http.StatusCreated)
		got(ada.CreateProjectWithResponse(ctx, &client.CreateProjectParams{}, client.CreateProjectBody{Key: "OPS", Name: "Ops"})).
			want(t, http.StatusCreated)

		// WEB's Workflow: the default, with QA (qa-acme) after Build in place of Review.
		wf := got(ada.GetWorkflowWithResponse(ctx, "WEB")).want(t, http.StatusOK).JSON200
		in := client.SetWorkflowBody{Workflows: []client.WorkflowInput{{Name: "Work", Position: 1}}, Moves: &map[string]string{}}
		for _, s := range wf.Steps {
			si := client.StepInput{ID: &s.ID, Workflow: "Work", Name: s.Name, Position: s.Position}
			if s.SkillID != nil {
				si.Skill = s.SkillID
			}
			if s.Name == "Review" {
				si.ID, si.Name, si.Skill = nil, "QA", ptrStr("qa-acme")
			}
			in.Steps = append(in.Steps, si)
		}
		for _, k := range []struct{ from, to, name string }{
			{"Plan", "", "done"}, {"Build", "QA", "pass"}, {"QA", "", "pass"}, {"QA", "Build", "fail"},
			{"Retro", "", "done"}, {"Retro", "Skill review", "propose"}, {"Skill review", "", "publish"}, {"Skill review", "Retro", "needs changes"},
		} {
			ci := client.ConnectorInput{From: k.from, Name: k.name, Position: int64(len(in.Connectors) + 1)}
			if k.to != "" {
				ci.To = ptrStr(k.to)
			}
			in.Connectors = append(in.Connectors, ci)
		}
		wf = got(ada.SetWorkflowWithResponse(ctx, "WEB", &client.SetWorkflowParams{IdempotencyKey: key("workflow")}, in)).want(t, http.StatusOK).JSON200
		if names := stepNames(wf); names != "Backlog Plan Build QA Retro Skill review" {
			t.Fatalf("WEB's Workflow: %s", names)
		}

		a, _ := h.member("planner", client.Agent, "WEB", "breakdown")
		b, bID := h.member("builder", client.Agent, "WEB", "engineer", "qa-acme")
		c, cID := h.member("tester", client.Agent, "WEB", "qa-acme")
		d, dID := h.member("retro", client.Agent, "WEB", "retro", "skill-review")
		e, eID := h.member("reviewer", client.Agent, "OPS", "skill-review")
		label := "claude-opus-5-5"
		next := func(cl *client.ClientWithResponses, idem string) client.TaskDetail {
			t.Helper()
			return *got(cl.NextTaskWithResponse(ctx, &client.NextTaskParams{IdempotencyKey: key(idem)},
				client.NextTaskBody{WaitSeconds: ptrInt(0), HeartbeatTimeoutSeconds: ptrInt(300), ModelLabel: &label})).want(t, http.StatusOK).JSON200
		}
		takeable := func(cl *client.ClientWithResponses) []string {
			t.Helper()
			var out []string
			for _, tk := range got(cl.ListTakeableTasksWithResponse(ctx, &client.ListTakeableTasksParams{})).want(t, http.StatusOK).JSON200.Items {
				out = append(out, tk.Key)
			}
			return out
		}
		advance := func(cl *client.ClientWithResponses, task, outcome, note string) client.Task {
			t.Helper()
			body := client.AdvanceTaskBody{Outcome: &outcome}
			if note != "" {
				body.Note = &note
			}
			return *got(cl.AdvanceTaskWithResponse(ctx, task, &client.AdvanceTaskParams{}, body)).want(t, http.StatusOK).JSON200
		}

		// 1. The human files the Task with Break down: a Parent from its first moment, its
		// Breakdown at Plan.
		parent := got(ada.FileTaskWithResponse(ctx, &client.FileTaskParams{IdempotencyKey: key("file")},
			client.FileTaskBody{Project: ptrStr("WEB"), Title: "Checkout", Breakdown: ptrBool(true)})).want(t, http.StatusCreated).JSON201
		pkey := parent.Task.Key
		if parent.Task.StepID != nil || !parent.Task.Breakdown || len(parent.Subtasks) != 1 || parent.Subtasks[0].Kind != client.Breakdown ||
			parent.Subtasks[0].StepID == nil || *parent.Subtasks[0].StepID != stepID(wf, "Plan") || parent.Subtasks[0].FiledBy != nil {
			t.Fatalf("filed %+v with %+v", parent.Task, parent.Subtasks)
		}

		// 2. A takes the Breakdown, files the Subtasks — at Build, the first work Step, unless
		// named — with their order, and advances it into Done along its one Connector.
		breakdown := next(a, "a-next")
		if breakdown.Task.Kind != client.Breakdown || breakdown.Task.Claim.ModelLabel == nil || *breakdown.Task.Claim.ModelLabel != label ||
			breakdown.Parent == nil || breakdown.Parent.Key != pkey || len(breakdown.Connectors) != 1 || breakdown.Connectors[0].Name != "done" {
			t.Fatalf("A took %+v under %+v, ways out %+v", breakdown.Task, breakdown.Parent, breakdown.Connectors)
		}
		build := h.file(a, client.FileTaskBody{Parent: &pkey, Title: "Build checkout", Step: ptrStr("Build")}).Task
		email := h.file(a, client.FileTaskBody{Parent: &pkey, Title: "Send the receipt"}).Task
		for _, tk := range []client.Task{build, email} {
			if tk.StepID == nil || *tk.StepID != stepID(wf, "Build") || tk.ParentID == nil || *tk.ParentID != parent.Task.ID || tk.Rank != nil ||
				tk.OwnerID != parent.Task.OwnerID {
				t.Fatalf("Subtask %+v", tk)
			}
		}
		got(a.AddBlockerWithResponse(ctx, email.Key, build.Key, &client.AddBlockerParams{})).want(t, http.StatusNoContent)
		advance(a, breakdown.Task.Key, "", "two Subtasks; the receipt waits for checkout")
		pd := got(ada.GetTaskWithResponse(ctx, pkey)).want(t, http.StatusOK).JSON200
		for _, tk := range pd.Subtasks {
			if tk.Key == email.Key && (tk.OpenBlockers == nil || len(*tk.OpenBlockers) != 1 || (*tk.OpenBlockers)[0].Key != build.Key) {
				t.Fatalf("the Parent does not name the receipt's blocker: %+v", tk)
			}
		}
		if pd.Task.SubtaskCounts == nil || *pd.Task.SubtaskCounts != (client.SubtaskCounts{Open: 2, Done: 1}) || len(pd.Subtasks) != 3 {
			t.Fatalf("the Parent's Subtasks %+v, counts %+v", pd.Subtasks, pd.Task.SubtaskCounts)
		}

		// 3. B builds: the blocked receipt waits, so next offers checkout.
		built := next(b, "b-next")
		if built.Task.Key != build.Key || built.Step == nil || built.Step.Name != "Build" || len(built.Connectors) != 1 || built.Connectors[0].Name != "pass" {
			t.Fatalf("B took %s at %+v, ways out %+v", built.Task.Key, built.Step, built.Connectors)
		}
		// Build has no way into Done: completing is refused, naming the ways out.
		ua := got(b.CompleteTaskWithResponse(ctx, build.Key, &client.CompleteTaskParams{}, client.CompleteTaskBody{})).want(t, http.StatusConflict)
		if ua.JSONDefault.Code != client.ErrorCodeUseAdvance || !hasOutcomes(ua.JSONDefault, "pass") {
			t.Fatalf("complete at Build: %s", ua.Body)
		}
		log := []byte("go build ./... ok\n")
		if res, err := b.AttachTaskEvidenceWithBodyWithResponse(ctx, build.Key, &client.AttachTaskEvidenceParams{Filename: "build.log"}, "text/plain", bytes.NewReader(log)); err != nil || res.StatusCode() != http.StatusCreated {
			t.Fatalf("B's Evidence: %v %s", err, res.Body)
		}
		got(b.ObserveWithResponse(ctx, build.Key, &client.ObserveParams{IdempotencyKey: key("obs")},
			client.ObserveBody{Outcome: client.DidntWork, Body: "qa-acme says nothing about an empty basket"})).want(t, http.StatusCreated)
		got(b.AddNoteWithResponse(ctx, build.Key, &client.AddNoteParams{}, client.AddNoteBody{Body: "the form is at /checkout"})).want(t, http.StatusCreated)
		nc := got(b.AdvanceTaskWithResponse(ctx, build.Key, &client.AdvanceTaskParams{IdempotencyKey: key("no-connector")},
			client.AdvanceTaskBody{Outcome: ptrStr("ship it")})).want(t, http.StatusConflict)
		if nc.JSONDefault.Code != client.ErrorCodeNoConnector || !hasOutcomes(nc.JSONDefault, "pass") {
			t.Fatalf("an outcome Build does not have: %s", nc.Body)
		}
		// The refusal is kept under its Idempotency-Key, details and all: a retry reads it back.
		again := got(b.AdvanceTaskWithResponse(ctx, build.Key, &client.AdvanceTaskParams{IdempotencyKey: key("no-connector")},
			client.AdvanceTaskBody{Outcome: ptrStr("ship it")})).want(t, http.StatusConflict)
		if !bytes.Equal(again.Body, nc.Body) || !hasOutcomes(again.JSONDefault, "pass") {
			t.Fatalf("the replayed refusal: %s, first %s", again.Body, nc.Body)
		}
		handed := advance(b, build.Key, "PASS", "ready for qa")
		if handed.Claim != nil || handed.StepID == nil || *handed.StepID != stepID(wf, "QA") || handed.SkillID == nil {
			t.Fatalf("advanced %+v", handed)
		}

		// 4. B has qa-acme, but cannot take the QA of its own build.
		if slices.Contains(takeable(b), build.Key) {
			t.Fatal("B can take the QA of its own Task")
		}
		refused := got(b.ClaimTaskWithResponse(ctx, build.Key, &client.ClaimTaskParams{}, client.ClaimTaskBody{})).want(t, http.StatusConflict)
		if refused.JSONDefault.Code != client.ErrorCodeNotTakeable {
			t.Fatalf("B's claim of the QA: %s", refused.Body)
		}

		// 5. C sends it back along "fail" with a Note; B, who built it, builds again; C then passes
		// it into Done with a report and a screenshot.
		verified := next(c, "c-next")
		if verified.Task.Key != build.Key || *verified.Task.Claim.SkillVersion != 1 || len(verified.Notes) != 2 || len(verified.Connectors) != 2 {
			t.Fatalf("C took %+v with %d Notes, ways out %+v", verified.Task, len(verified.Notes), verified.Connectors)
		}
		back := advance(c, build.Key, "fail", "an empty basket shows a blank page")
		if *back.StepID != stepID(wf, "Build") {
			t.Fatalf("sent back to %v", back.StepID)
		}
		if again := next(b, "b-next-again"); again.Task.Key != build.Key {
			t.Fatalf("B then took %s", again.Task.Key)
		}
		advance(b, build.Key, "pass", "empty baskets handled")
		next(c, "c-next-again")
		for _, file := range []struct{ name, ct, body string }{
			{"report.txt", "text/plain", "12 passed, 0 failed\n"},
			{"checkout.png", "image/png", "\x89PNG\r\n\x1a\n…"},
		} {
			res, err := c.AttachTaskEvidenceWithBodyWithResponse(ctx, build.Key, &client.AttachTaskEvidenceParams{Filename: file.name}, file.ct, strings.NewReader(file.body))
			if err != nil || res.StatusCode() != http.StatusCreated || res.JSON201.AttachedBy != cID {
				t.Fatalf("C's %s: %v %s", file.name, err, res.Body)
			}
		}
		done := advance(c, build.Key, "pass", "verified")
		if done.State != client.TaskStateDone || done.StepID != nil || done.EndedAt == nil {
			t.Fatalf("passed into Done %+v", done)
		}
		receipt := next(b, "b-next-2")
		if receipt.Task.Key != email.Key {
			t.Fatalf("B then took %s", receipt.Task.Key)
		}
		advance(b, email.Key, "pass", "")
		next(c, "c-next-2")
		// QA has one way into Done, so its holder may complete it.
		got(c.CompleteTaskWithResponse(ctx, email.Key, &client.CompleteTaskParams{}, client.CompleteTaskBody{})).want(t, http.StatusOK)

		// The Task's record: four Claims, each with its Skill, version and model label.
		record := got(ada.GetTaskWithResponse(ctx, build.Key)).want(t, http.StatusOK).JSON200
		if len(record.Claims) != 4 || len(record.Evidence) != 3 || len(record.Observations) != 1 || len(record.Notes) != 5 ||
			record.Parent == nil || record.Parent.Key != pkey {
			t.Fatalf("record: %d Claims, %d Evidence, %d Observations, %d Notes, Parent %+v", len(record.Claims), len(record.Evidence),
				len(record.Observations), len(record.Notes), record.Parent)
		}
		for _, cl := range record.Claims {
			if cl.ModelLabel == nil || *cl.ModelLabel != label || cl.SkillVersion == nil || *cl.HowEnded != client.ClaimEndAdvanced &&
				*cl.HowEnded != client.ClaimEndCompleted {
				t.Fatalf("claim %+v", cl)
			}
		}

		// 6. The Owner completes the Parent; its Retrospective is filed with it.
		completed := got(ada.CompleteTaskWithResponse(ctx, pkey, &client.CompleteTaskParams{IdempotencyKey: key("complete")},
			client.CompleteTaskBody{})).want(t, http.StatusOK).JSON200
		pd = got(ada.GetTaskWithResponse(ctx, pkey)).want(t, http.StatusOK).JSON200
		retro := pd.Subtasks[len(pd.Subtasks)-1]
		if completed.State != client.TaskStateDone || retro.Kind != client.Retrospective || retro.Title != "Retrospective: Checkout" ||
			*retro.StepID != stepID(wf, "Retro") {
			t.Fatalf("completed %+v with %+v", completed, retro)
		}

		// 7. D takes the Retrospective, reads the Observations, proposes and advances to Skill review.
		r := next(d, "d-next")
		if r.Task.Key != retro.Key {
			t.Fatalf("D took %s", r.Task.Key)
		}
		obs := got(d.ListTaskObservationsWithResponse(ctx, pkey, &client.ListTaskObservationsParams{})).want(t, http.StatusOK).JSON200
		if len(obs.Items) != 1 || obs.Items[0].AuthorID != bID || obs.Items[0].Outcome != client.DidntWork {
			t.Fatalf("Observations %+v", obs.Items)
		}
		stale := got(d.ProposeSkillVersionWithResponse(ctx, retro.Key, &client.ProposeSkillVersionParams{},
			client.ProposeSkillVersionBody{Skill: "qa-acme", BasedOnVersion: 2, Body: "x"})).want(t, http.StatusConflict)
		if stale.JSONDefault.Code != client.ErrorCodeProposalStale {
			t.Fatalf("stale proposal: %s", stale.Body)
		}
		proposal := got(d.ProposeSkillVersionWithResponse(ctx, retro.Key, &client.ProposeSkillVersionParams{IdempotencyKey: key("propose")},
			client.ProposeSkillVersionBody{Skill: "qa-acme", BasedOnVersion: 1, Body: "Test the happy path and an empty basket."})).want(t, http.StatusCreated).JSON201
		advance(d, retro.Key, "propose", "")
		carried := got(e.GetTaskWithResponse(ctx, retro.Key)).want(t, http.StatusOK).JSON200
		if len(carried.Proposals) != 1 || carried.Proposals[0].ID != proposal.ID || carried.Proposals[0].AuthorID != dID ||
			carried.Proposals[0].State != client.Pending || carried.Step == nil || carried.Step.Name != "Skill review" {
			t.Fatalf("the Task carries %+v at %+v", carried.Proposals, carried.Step)
		}

		// 8. D has skill-review, and still cannot take the review of its own proposal.
		if slices.Contains(takeable(d), retro.Key) {
			t.Fatal("D can take the review of its own proposal")
		}
		got(d.ClaimTaskWithResponse(ctx, retro.Key, &client.ClaimTaskParams{}, client.ClaimTaskBody{})).want(t, http.StatusConflict)

		// 9. E, from another Project, publishes version 2 by advancing into Done.
		review := next(e, "e-next")
		if review.Task.Key != retro.Key {
			t.Fatalf("E took %s", review.Task.Key)
		}
		advance(e, retro.Key, "publish", "")
		skill := got(e.GetSkillWithResponse(ctx, "qa-acme")).want(t, http.StatusOK).JSON200
		if skill.Skill.CurrentVersion != 2 || skill.Current.Body != proposal.Body || *skill.Current.PublishedBy != eID || *skill.Current.ProposalID != proposal.ID {
			t.Fatalf("qa-acme %+v", skill)
		}
		published := got(ada.GetSkillProposalWithResponse(ctx, proposal.ID)).want(t, http.StatusOK).JSON200
		if published.State != client.Published || *published.PublishedVersion != 2 {
			t.Fatalf("proposal %+v", published)
		}

		// 10. The Observations are reviewed by the Retrospective.
		if left := got(d.ListTaskObservationsWithResponse(ctx, pkey, &client.ListTaskObservationsParams{})).want(t, http.StatusOK).JSON200; len(left.Items) != 0 {
			t.Fatalf("unreviewed %+v", left.Items)
		}
		all := got(d.ListTaskObservationsWithResponse(ctx, pkey, &client.ListTaskObservationsParams{Reviewed: ptrBool(true)})).want(t, http.StatusOK).JSON200
		if len(all.Items) != 1 || all.Items[0].ReviewedByTaskID == nil || *all.Items[0].ReviewedByTaskID != retro.ID {
			t.Fatalf("all Observations %+v", all.Items)
		}

		// 11. D files a Task for the problem found, linked to the Retrospective, at QA; a qa-acme
		// Claim made now records version 2.
		fix := h.file(d, client.FileTaskBody{Project: ptrStr("WEB"), Title: "Test an empty basket", Owner: ptrStr("ada"),
			FromRetrospective: &retro.Key, Step: ptrStr("QA")}).Task
		if fix.FromRetrospectiveTaskID == nil || *fix.FromRetrospectiveTaskID != retro.ID || fix.ParentID != nil || fix.Rank == nil || *fix.Rank != 2 {
			t.Fatalf("filed %+v", fix)
		}
		later := got(c.ClaimTaskWithResponse(ctx, fix.Key, &client.ClaimTaskParams{}, client.ClaimTaskBody{ModelLabel: &label})).want(t, http.StatusOK).JSON200
		if *later.Task.Claim.SkillVersion != 2 {
			t.Fatalf("a later Claim records version %d", *later.Task.Claim.SkillVersion)
		}

		// The record of it all: every entry's subject type names its kind's area, and the model
		// label is in the claims' Activity.
		act := got(ada.ListActivityWithResponse(ctx, &client.ListActivityParams{Limit: ptrInt(500)})).want(t, http.StatusOK).JSON200
		seen := map[client.ActivityKind]bool{}
		for _, en := range act.Items {
			seen[en.Kind] = true
			if area, _, _ := strings.Cut(string(en.Kind), "."); area != string(en.SubjectType) {
				t.Errorf("entry %d: %s about a %s", en.Seq, en.Kind, en.SubjectType)
			}
			if en.Kind == client.ActivityKindTaskClaimed && en.Payload["model_label"] != label {
				t.Errorf("claim entry %d without the model label: %v", en.Seq, en.Payload)
			}
		}
		for _, k := range []client.ActivityKind{client.ActivityKindTaskAdvanced, client.ActivityKindTaskObserved, client.ActivityKindTaskNoteAdded,
			client.ActivityKindTaskEvidenceAttached, client.ActivityKindTaskBlockerAdded, client.ActivityKindTaskCompleted,
			client.ActivityKindTaskSkillProposed, client.ActivityKindSkillVersionPublished, client.ActivityKindWorkflowChanged} {
			if !seen[k] {
				t.Errorf("no %s in Activity", k)
			}
		}
	})
}

// stepNames is the names of a Workflow's Steps, in order.
func stepNames(w *client.Workflows) string {
	var names []string
	for _, s := range w.Steps {
		names = append(names, s.Name)
	}
	return strings.Join(names, " ")
}

// stepID is the id of the Workflow's Step named name.
func stepID(w *client.Workflows, name string) string {
	for _, s := range w.Steps {
		if s.Name == name {
			return s.ID
		}
	}
	return ""
}

// hasOutcomes reports whether a refusal's details list exactly the outcomes given, in order.
func hasOutcomes(e *client.Error, outcomes ...string) bool {
	if e == nil || e.Details == nil {
		return false
	}
	list, _ := (*e.Details)["outcomes"].([]any)
	if len(list) != len(outcomes) {
		return false
	}
	for i, o := range outcomes {
		if list[i] != o {
			return false
		}
	}
	return true
}
