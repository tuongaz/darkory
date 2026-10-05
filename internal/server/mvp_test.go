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

// The MVP flow end to end through the generated Go client, on both engines: a human files a
// Feature; agent A breaks it down; agent B builds, attaches Evidence, records an Observation and
// hands over to qa, whose stage B cannot take; agent C verifies with a report and a screenshot;
// the owner ships; the Retrospective is filed; agent D reads the Observations, proposes a Skill
// version and hands it to review, which D cannot publish; agent E, from another Team, publishes
// it; a later Claim records the new version; the Observations are reviewed.
func TestMVPFlowThroughTheClient(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		ada := h.admin // the human, an admin, who owns the Feature
		for _, tm := range []client.CreateTeamBody{{Key: "WEB", Name: "Web"}, {Key: "OPS", Name: "Ops"}} {
			got(ada.CreateTeamWithResponse(ctx, &client.CreateTeamParams{}, tm)).want(t, http.StatusCreated)
		}
		got(ada.AddTeamMemberWithResponse(ctx, "WEB", "ada", &client.AddTeamMemberParams{})).want(t, http.StatusNoContent)
		for _, sk := range []client.CreateSkillBody{
			{Name: "build", Kind: client.Generic, Body: "Build it."},
			{Name: "qa", Kind: client.Generic, Body: "Test it."},
			{Name: "qa-acme", Kind: client.Company, BaseSkill: ptrStr("qa"), Body: "Test the happy path in the browser."},
		} {
			got(ada.CreateSkillWithResponse(ctx, &client.CreateSkillParams{}, sk)).want(t, http.StatusCreated)
		}
		a, _ := h.member("planner", client.Agent, "WEB", "breakdown")
		b, bID := h.member("builder", client.Agent, "WEB", "build", "qa-acme")
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

		// 1. The human files the Feature, with its Break down.
		feature := got(ada.FileFeatureWithResponse(ctx, &client.FileFeatureParams{IdempotencyKey: key("feature")},
			client.FileFeatureBody{Team: "WEB", Title: "Checkout"})).want(t, http.StatusCreated).JSON201
		fkey := feature.Feature.Key

		// 2. A takes the Break down, files the build Tasks with their order, and completes it.
		breakdown := next(a, "a-next")
		if breakdown.Task.Kind != client.Breakdown || breakdown.Task.Claim.ModelLabel == nil || *breakdown.Task.Claim.ModelLabel != label {
			t.Fatalf("A took %+v", breakdown.Task)
		}
		build := got(a.FileTaskWithResponse(ctx, &client.FileTaskParams{}, client.FileTaskBody{Feature: &fkey, Title: "Build checkout", Skill: ptrStr("build")})).want(t, http.StatusCreated).JSON201.Task
		email := got(a.FileTaskWithResponse(ctx, &client.FileTaskParams{}, client.FileTaskBody{Feature: &fkey, Title: "Send the receipt", Skill: ptrStr("build")})).want(t, http.StatusCreated).JSON201.Task
		got(a.AddBlockerWithResponse(ctx, email.Key, build.Key, &client.AddBlockerParams{})).want(t, http.StatusNoContent)
		got(a.CompleteTaskWithResponse(ctx, breakdown.Task.Key, &client.CompleteTaskParams{}, client.CompleteTaskBody{Note: ptrStr("two Tasks; the receipt waits for checkout")})).want(t, http.StatusOK)
		fd := got(ada.GetFeatureWithResponse(ctx, fkey)).want(t, http.StatusOK).JSON200
		for _, tk := range fd.Tasks {
			if tk.Key == email.Key && (tk.OpenBlockers == nil || len(*tk.OpenBlockers) != 1 || (*tk.OpenBlockers)[0].Key != build.Key) {
				t.Fatalf("the Feature does not name the receipt's blocker: %+v", tk)
			}
		}
		if fd.Feature.TaskCounts != (client.TaskCounts{Open: 2, Done: 1}) {
			t.Fatalf("counts %+v", fd.Feature.TaskCounts)
		}

		// 3. B builds: the blocked receipt waits, so next offers checkout.
		built := next(b, "b-next")
		if built.Task.Key != build.Key {
			t.Fatalf("B took %s, want %s", built.Task.Key, build.Key)
		}
		log := []byte("go build ./... ok\n")
		if res, err := b.AttachTaskEvidenceWithBodyWithResponse(ctx, build.Key, &client.AttachTaskEvidenceParams{Filename: "build.log"}, "text/plain", bytes.NewReader(log)); err != nil || res.StatusCode() != http.StatusCreated {
			t.Fatalf("B's Evidence: %v %s", err, res.Body)
		}
		got(b.ObserveWithResponse(ctx, build.Key, &client.ObserveParams{IdempotencyKey: key("obs")},
			client.ObserveBody{Outcome: client.DidntWork, Body: "qa-acme says nothing about an empty basket"})).want(t, http.StatusCreated)
		got(b.AddNoteWithResponse(ctx, build.Key, &client.AddNoteParams{}, client.AddNoteBody{Body: "the form is at /checkout"})).want(t, http.StatusCreated)
		handed := got(b.HandoverTaskWithResponse(ctx, build.Key, &client.HandoverTaskParams{IdempotencyKey: key("handover")},
			client.HandoverTaskBody{Skill: "qa-acme", Note: ptrStr("ready for qa")})).want(t, http.StatusOK).JSON200
		if handed.Claim != nil || handed.SkillID == nil {
			t.Fatalf("handed over %+v", handed)
		}

		// 4. B has qa-acme, but cannot take the qa stage of its own Task.
		if slices.Contains(takeable(b), build.Key) {
			t.Fatal("B can take the qa stage of its own Task")
		}
		refused := got(b.ClaimTaskWithResponse(ctx, build.Key, &client.ClaimTaskParams{}, client.ClaimTaskBody{})).want(t, http.StatusConflict)
		if refused.JSONDefault.Code != client.ErrorCodeNotTakeable {
			t.Fatalf("B's claim of the qa stage: %s", refused.Body)
		}

		// 5. C verifies, attaching a test report and a screenshot, and completes.
		verified := next(c, "c-next")
		if verified.Task.Key != build.Key || *verified.Task.Claim.SkillVersion != 1 || len(verified.Notes) != 2 {
			t.Fatalf("C took %+v with %d Notes", verified.Task, len(verified.Notes))
		}
		for _, file := range []struct{ name, ct, body string }{
			{"report.txt", "text/plain", "12 passed, 0 failed\n"},
			{"checkout.png", "image/png", "\x89PNG\r\n\x1a\n…"},
		} {
			res, err := c.AttachTaskEvidenceWithBodyWithResponse(ctx, build.Key, &client.AttachTaskEvidenceParams{Filename: file.name}, file.ct, strings.NewReader(file.body))
			if err != nil || res.StatusCode() != http.StatusCreated || res.JSON201.AttachedBy != cID {
				t.Fatalf("C's %s: %v %s", file.name, err, res.Body)
			}
		}
		got(c.CompleteTaskWithResponse(ctx, build.Key, &client.CompleteTaskParams{}, client.CompleteTaskBody{Note: ptrStr("verified")})).want(t, http.StatusOK)
		receipt := next(b, "b-next-2")
		if receipt.Task.Key != email.Key {
			t.Fatalf("B then took %s", receipt.Task.Key)
		}
		got(b.CompleteTaskWithResponse(ctx, email.Key, &client.CompleteTaskParams{}, client.CompleteTaskBody{})).want(t, http.StatusOK)

		// The Task's record: three Claims, each with its Skill, version and model label.
		record := got(ada.GetTaskWithResponse(ctx, build.Key)).want(t, http.StatusOK).JSON200
		if len(record.Claims) != 2 || len(record.Evidence) != 3 || len(record.Observations) != 1 || len(record.Notes) != 3 {
			t.Fatalf("record: %d Claims, %d Evidence, %d Observations, %d Notes", len(record.Claims), len(record.Evidence), len(record.Observations), len(record.Notes))
		}
		for _, cl := range record.Claims {
			if cl.ModelLabel == nil || *cl.ModelLabel != label || cl.SkillVersion == nil {
				t.Fatalf("claim %+v", cl)
			}
		}

		// 6. The owner ships; the Retrospective is filed with it.
		shipped := got(ada.ShipFeatureWithResponse(ctx, fkey, &client.ShipFeatureParams{IdempotencyKey: key("ship")})).want(t, http.StatusOK).JSON200
		retro := shipped.Tasks[len(shipped.Tasks)-1]
		if shipped.Feature.State != client.FeatureStateShipped || retro.Kind != client.Retrospective || retro.Title != "Retrospective: Checkout" {
			t.Fatalf("shipped %+v with %+v", shipped.Feature, retro)
		}

		// 7. D takes the Retrospective, reads the Observations, proposes and hands to review.
		r := next(d, "d-next")
		if r.Task.Key != retro.Key {
			t.Fatalf("D took %s", r.Task.Key)
		}
		obs := got(d.ListFeatureObservationsWithResponse(ctx, fkey, &client.ListFeatureObservationsParams{})).want(t, http.StatusOK).JSON200
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
		got(d.HandoverTaskWithResponse(ctx, retro.Key, &client.HandoverTaskParams{}, client.HandoverTaskBody{Skill: "skill-review"})).want(t, http.StatusOK)
		carried := got(e.GetTaskWithResponse(ctx, retro.Key)).want(t, http.StatusOK).JSON200.Proposal
		if carried == nil || carried.ID != proposal.ID || carried.AuthorID != dID || carried.BasedOnVersion != 1 || carried.State != client.Pending {
			t.Fatalf("the Task carries %+v", carried)
		}

		// 8. D has skill-review, and still cannot take the review of its own proposal.
		if slices.Contains(takeable(d), retro.Key) {
			t.Fatal("D can take the review of its own proposal")
		}
		got(d.ClaimTaskWithResponse(ctx, retro.Key, &client.ClaimTaskParams{}, client.ClaimTaskBody{})).want(t, http.StatusConflict)

		// 9. E, from another Team, publishes version 2.
		review := next(e, "e-next")
		if review.Task.Key != retro.Key {
			t.Fatalf("E took %s", review.Task.Key)
		}
		got(e.CompleteTaskWithResponse(ctx, retro.Key, &client.CompleteTaskParams{IdempotencyKey: key("publish")}, client.CompleteTaskBody{})).want(t, http.StatusOK)
		skill := got(e.GetSkillWithResponse(ctx, "qa-acme")).want(t, http.StatusOK).JSON200
		if skill.Skill.CurrentVersion != 2 || skill.Current.Body != proposal.Body || *skill.Current.PublishedBy != eID || *skill.Current.ProposalID != proposal.ID {
			t.Fatalf("qa-acme %+v", skill)
		}
		published := got(ada.GetSkillProposalWithResponse(ctx, proposal.ID)).want(t, http.StatusOK).JSON200
		if published.State != client.Published || *published.PublishedVersion != 2 {
			t.Fatalf("proposal %+v", published)
		}

		// 10. The Observations are reviewed by the Retrospective.
		if left := got(d.ListFeatureObservationsWithResponse(ctx, fkey, &client.ListFeatureObservationsParams{})).want(t, http.StatusOK).JSON200; len(left.Items) != 0 {
			t.Fatalf("unreviewed %+v", left.Items)
		}
		all := got(d.ListFeatureObservationsWithResponse(ctx, fkey, &client.ListFeatureObservationsParams{Reviewed: ptrBool(true)})).want(t, http.StatusOK).JSON200
		if len(all.Items) != 1 || all.Items[0].ReviewedByTaskID == nil || *all.Items[0].ReviewedByTaskID != retro.ID {
			t.Fatalf("all Observations %+v", all.Items)
		}

		// 11. D files a Feature for the problem found, linked to the Retrospective; a qa-acme Claim
		// made now records version 2.
		fix := got(d.FileFeatureWithResponse(ctx, &client.FileFeatureParams{}, client.FileFeatureBody{Team: "WEB", Title: "Empty baskets",
			Owner: ptrStr("ada"), FromRetrospective: &retro.Key})).want(t, http.StatusCreated).JSON201
		if fix.Feature.FromRetrospectiveTaskID == nil || *fix.Feature.FromRetrospectiveTaskID != retro.ID {
			t.Fatalf("filed %+v", fix.Feature)
		}
		check := got(ada.FileTaskWithResponse(ctx, &client.FileTaskParams{}, client.FileTaskBody{Feature: &fix.Feature.Key,
			Title: "Test an empty basket", Skill: ptrStr("qa-acme")})).want(t, http.StatusCreated).JSON201.Task
		later := got(c.ClaimTaskWithResponse(ctx, check.Key, &client.ClaimTaskParams{}, client.ClaimTaskBody{ModelLabel: &label})).want(t, http.StatusOK).JSON200
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
		for _, k := range []client.ActivityKind{client.ActivityKindTaskHandedOver, client.ActivityKindTaskObserved, client.ActivityKindTaskNoteAdded,
			client.ActivityKindTaskEvidenceAttached, client.ActivityKindTaskBlockerAdded, client.ActivityKindFeatureShipped,
			client.ActivityKindTaskSkillProposed, client.ActivityKindSkillVersionPublished} {
			if !seen[k] {
				t.Errorf("no %s in Activity", k)
			}
		}
	})
}

func ptrBool(b bool) *bool { return &b }
