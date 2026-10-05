package e2e

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/client"
)

// The six steps of the MVP flow (map, "MVP flow the architecture must support") through the real
// binary, with a human owner and six agent Members, each with its own token and Session:
//
//  1. Members are specialists with Skills.
//  2. The human files a Feature; eng, through darkory mcp, takes its Break down and files the Tasks.
//  3. eng builds through the CLI and hands over to qa-acme, which eng may not take; qa asks the
//     owner a blocking question and keeps its Claim, then verifies and hands over to ui-review;
//     uiux hands over to security-review; sec completes.
//  4. The Feature carries a test report and a screenshot.
//  5. The owner ships, refused while Tasks were open.
//  6. The Retrospective reads the Observations and proposes qa-acme v2, which its author may not
//     publish and a reviewer from another Team does; a Feature filed from it records the link, and
//     a later qa Claim works under version 2.
func TestMVPFlow(t *testing.T) {
	in := newInstall(t)
	ada := in.ada
	work := t.TempDir()
	const engModel, qaModel = "claude-opus-5-5", "claude-sonnet-5-5"

	// 1. The Organisation: two Teams, the Skills, and the specialists.
	ada.ok("team", "create", "WEB", "Web")
	ada.ok("team", "create", "OPS", "Ops")
	ada.ok("team", "add", "WEB", "ada")
	for _, s := range [][]string{
		{"build", "--kind", "generic", "--body", "Build it."},
		{"qa", "--kind", "generic", "--body", "Test it."},
		{"qa-acme", "--kind", "company", "--base", "qa", "--body", "Test the happy path in the browser."},
		{"ui-review", "--kind", "generic", "--body", "Review the screens."},
		{"security-review", "--kind", "generic", "--body", "Review for security."},
	} {
		ada.ok(append([]string{"skill", "create"}, s...)...)
	}
	// eng holds qa-acme and retro holds skill-review, so that the refusals below come from the
	// no-self-review rule rather than from a missing Skill.
	eng := in.agent("eng", []string{"WEB"}, []string{"breakdown", "build", "qa-acme"})
	qa := in.agent("qa", []string{"WEB"}, []string{"qa", "qa-acme"})
	uiux := in.agent("uiux", []string{"WEB"}, []string{"ui-review"})
	sec := in.agent("sec", []string{"WEB"}, []string{"security-review"})
	retro := in.agent("retro", []string{"WEB"}, []string{"retro", "skill-review"})
	reviewer := in.agent("reviewer", []string{"OPS"}, []string{"skill-review"})
	ada.ok("report-to", "eng", "ada")
	var v1 client.SkillDetail
	ada.json(&v1, "skill", "show", "qa-acme")
	if v1.Skill.CurrentVersion != 1 || v1.Current.Body != "Test the happy path in the browser." {
		t.Fatalf("qa-acme starts as %+v", v1)
	}

	// 2. The human files the Feature, which comes with its Break down.
	var feature client.FeatureDetail
	ada.json(&feature, "feature", "create", "--team", "WEB", "--title", "Checkout", "--body", "Customers pay for their basket.")
	fkey := feature.Feature.Key
	if feature.Feature.OwnerID != ada.id || len(feature.Tasks) != 1 || feature.Tasks[0].Kind != client.Breakdown {
		t.Fatalf("filed %+v with %+v", feature.Feature, feature.Tasks)
	}
	ada.refused(3, client.ErrorCodeTasksOpen, "feature", "ship", fkey)

	// eng, through darkory mcp, takes the Break down and files the build Tasks with their order.
	mcp := eng.mcp(work)
	var took struct {
		Claimed bool              `json:"claimed"`
		Task    client.TaskDetail `json:"task"`
	}
	mcp.call("next", map[string]any{"wait_seconds": 5, "heartbeat_timeout_seconds": 60, "model_label": engModel}, &took)
	bd := took.Task.Task
	if !took.Claimed || bd.Kind != client.Breakdown || bd.Claim == nil || bd.Claim.SessionID != eng.session ||
		bd.Claim.ModelLabel == nil || *bd.Claim.ModelLabel != engModel {
		t.Fatalf("eng took %+v", took)
	}
	var build, receipt client.TaskDetail
	mcp.call("file_task", map[string]any{"feature": fkey, "title": "Build checkout", "skill": "build",
		"description": "The form at /checkout and the call to the payment provider."}, &build)
	mcp.call("file_task", map[string]any{"feature": fkey, "title": "Send the receipt", "skill": "build"}, &receipt)
	mcp.call("block", map[string]any{"task": receipt.Task.Key, "blocker": build.Task.Key}, nil)
	mcp.refused("block", map[string]any{"task": build.Task.Key, "blocker": receipt.Task.Key}, client.ErrorCodeCycle)
	mcp.call("complete", map[string]any{"task": bd.Key, "note": "two Tasks; the receipt waits for checkout"}, nil)
	mcp.close()
	ada.json(&feature, "feature", "show", fkey)
	if feature.Feature.TaskCounts != (client.TaskCounts{Open: 2, Done: 1}) {
		t.Fatalf("after the Break down: %+v", feature.Feature.TaskCounts)
	}

	// 3. eng builds through the CLI: next offers checkout, since the receipt is blocked.
	var built client.TaskDetail
	eng.json(&built, "next", "--wait", "5s", "--timeout", "2m", "--model", engModel)
	bkey := built.Task.Key
	if bkey != build.Task.Key || built.Task.Claim.SkillVersion == nil {
		t.Fatalf("eng took %+v, want %s", built.Task, build.Task.Key)
	}
	eng.ok("note", bkey, "the form is at /checkout")
	var buildLog client.Evidence
	eng.json(&buildLog, "attach", bkey, writeFile(t, filepath.Join(work, "build.log"), "go build ./... ok\n"))
	if buildLog.AttachedBy != eng.id || buildLog.ContentType != "text/plain; charset=utf-8" && buildLog.ContentType != "text/plain" {
		t.Fatalf("eng's Evidence %+v", buildLog)
	}
	var obs client.Observation
	eng.json(&obs, "observe", bkey, "--didnt-work", "qa-acme says nothing about an empty basket")
	if obs.AuthorID != eng.id || obs.Outcome != client.DidntWork || obs.SkillID == nil {
		t.Fatalf("eng's Observation %+v", obs)
	}
	var hb client.HeartbeatReply
	eng.json(&hb, "heartbeat", bkey)
	if hb.Status != client.HeartbeatStatusOk || hb.ExpiresAt == nil {
		t.Fatalf("eng's Heartbeat %+v", hb)
	}
	var handed client.Task
	eng.json(&handed, "handover", bkey, "--skill", "qa-acme", "--note", "ready for qa")
	if handed.Claim != nil || handed.SkillID == nil || *handed.SkillID != skillID(t, ada, "qa-acme") {
		t.Fatalf("handed over %+v", handed)
	}

	// eng holds qa-acme, but no one judges their own work.
	if slices.Contains(takeableKeys(eng), bkey) {
		t.Fatal("eng can take the qa stage of its own Task")
	}
	eng.refused(3, client.ErrorCodeNotTakeable, "claim", bkey, "--timeout", "1m")

	// qa takes it, gets stuck, and asks the Feature owner, keeping its Claim.
	var verifying client.TaskDetail
	qa.json(&verifying, "next", "--wait", "5s", "--timeout", "2m", "--model", qaModel)
	if verifying.Task.Key != bkey || *verifying.Task.Claim.SkillVersion != 1 || len(verifying.Notes) != 2 || len(verifying.Observations) != 1 {
		t.Fatalf("qa took %+v with %d Notes", verifying.Task, len(verifying.Notes))
	}
	var question client.TaskDetail
	qa.json(&question, "file", "--title", "Should an empty basket show an error?", "--aim", "ada", "--blocks", bkey)
	qkey := question.Task.Key
	if question.Task.FeatureID != feature.Feature.ID || question.Task.AimedAtID == nil || *question.Task.AimedAtID != ada.id ||
		len(question.Blocking) != 1 || question.Blocking[0].Key != bkey {
		t.Fatalf("question %+v blocking %+v", question.Task, question.Blocking)
	}
	var held client.TaskDetail
	qa.json(&held, "show", bkey)
	if !held.Task.Blocked || held.Task.Claim == nil || held.Task.Claim.HolderID != qa.id {
		t.Fatalf("qa's Task while it waits %+v", held.Task)
	}
	qa.json(&hb, "heartbeat", bkey)
	if hb.Status != client.HeartbeatStatusOk {
		t.Fatalf("qa's Heartbeat while it waits %+v", hb)
	}

	// The human answers by completing the question, with a Claim bound to them, not a Session.
	if !slices.Contains(takeableKeys(ada), qkey) {
		t.Fatal("the owner cannot take the question aimed at them")
	}
	var answering client.TaskDetail
	ada.json(&answering, "claim", qkey, "--timeout", "0")
	if answering.Task.Claim.HeartbeatTimeoutSeconds != nil || answering.Task.Claim.SkillID != nil {
		t.Fatalf("the owner's Claim on the question %+v", answering.Task.Claim)
	}
	ada.ok("complete", qkey, "--note", "Yes: show 'Your basket is empty' and no pay button.")
	qa.json(&held, "show", bkey)
	if held.Task.Blocked || held.Task.Claim == nil || held.Task.Claim.HolderID != qa.id {
		t.Fatalf("qa's Task once answered %+v", held.Task)
	}

	// 4. qa verifies, with a test report and a screenshot, and hands over to ui-review.
	qa.ok("note", bkey, "an empty basket shows the message, per the owner")
	var report, shot client.Evidence
	qa.json(&report, "attach", bkey, writeFile(t, filepath.Join(work, "report.txt"), "12 passed, 0 failed\n"))
	writePNG(t, filepath.Join(work, "checkout.png"))
	qa.json(&shot, "attach", bkey, filepath.Join(work, "checkout.png"))
	if report.AttachedBy != qa.id || shot.AttachedBy != qa.id || shot.ContentType != "image/png" || shot.Size < 50 {
		t.Fatalf("qa's Evidence %+v, %+v", report, shot)
	}
	qa.ok("evidence", "get", shot.ID, "-o", filepath.Join(work, "downloaded.png"))
	if a, b := readFile(t, filepath.Join(work, "checkout.png")), readFile(t, filepath.Join(work, "downloaded.png")); a != b {
		t.Fatal("the screenshot downloads changed")
	}
	qa.ok("observe", bkey, "--worked", "the owner answered the question within minutes")
	qa.json(&handed, "handover", bkey, "--skill", "ui-review")

	// uiux reviews and hands over to security-review; sec completes.
	var reviewing client.TaskDetail
	uiux.json(&reviewing, "next", "--wait", "5s", "--timeout", "2m")
	if reviewing.Task.Key != bkey || len(reviewing.Evidence) != 3 {
		t.Fatalf("uiux took %+v with %d Evidence", reviewing.Task, len(reviewing.Evidence))
	}
	uiux.ok("handover", bkey, "--skill", "security-review", "--note", "the empty-basket message reads well")
	sec.json(&reviewing, "next", "--wait", "5s", "--timeout", "2m")
	if reviewing.Task.Key != bkey {
		t.Fatalf("sec took %s", reviewing.Task.Key)
	}
	var done client.Task
	sec.json(&done, "complete", bkey, "--note", "no secrets in the form")
	if done.State != client.TaskStateDone || done.Claim != nil {
		t.Fatalf("completed %+v", done)
	}

	// 5. The receipt is still open, so the owner cannot ship yet; eng then builds it.
	ada.refused(3, client.ErrorCodeTasksOpen, "feature", "ship", fkey)
	var second client.TaskDetail
	eng.json(&second, "next", "--wait", "5s", "--timeout", "2m", "--model", engModel)
	if second.Task.Key != receipt.Task.Key || second.Task.Blocked {
		t.Fatalf("eng then took %+v", second.Task)
	}
	eng.ok("complete", receipt.Task.Key)

	var record client.TaskDetail
	ada.json(&record, "show", bkey)
	if len(record.Claims) != 4 || len(record.Evidence) != 3 || len(record.Observations) != 2 || len(record.Notes) != 5 {
		t.Fatalf("the record: %d Claims, %d Evidence, %d Observations, %d Notes", len(record.Claims), len(record.Evidence),
			len(record.Observations), len(record.Notes))
	}
	if c := record.Claims[1]; c.HolderID != qa.id || *c.SkillVersion != 1 || *c.ModelLabel != qaModel || *c.HowEnded != client.ClaimEndHandedOver {
		t.Fatalf("qa's Claim %+v", c)
	}
	var shipped client.FeatureDetail
	ada.json(&shipped, "feature", "ship", fkey)
	retroTask := shipped.Tasks[len(shipped.Tasks)-1]
	if shipped.Feature.State != client.FeatureStateShipped || retroTask.Kind != client.Retrospective ||
		retroTask.Title != "Retrospective: Checkout" || retroTask.State != client.TaskStateOpen {
		t.Fatalf("shipped %+v with %+v", shipped.Feature, retroTask)
	}
	rkey := retroTask.Key

	// 6. retro reads the Observations and proposes qa-acme v2.
	var r client.TaskDetail
	retro.json(&r, "next", "--wait", "5s", "--timeout", "2m")
	if r.Task.Key != rkey {
		t.Fatalf("retro took %s, want %s", r.Task.Key, rkey)
	}
	var unreviewed client.ObservationList
	retro.json(&unreviewed, "feature", "observations", fkey)
	if len(unreviewed.Items) != 2 || unreviewed.Items[0].AuthorID != eng.id || unreviewed.Items[0].Outcome != client.DidntWork {
		t.Fatalf("Observations %+v", unreviewed.Items)
	}
	body := "Test the happy path in the browser, and an empty basket."
	retro.refused(3, client.ErrorCodeProposalStale, "propose", rkey, "--skill", "qa-acme", "--base", "2", "--file",
		writeFile(t, filepath.Join(work, "stale.md"), body))
	var proposal client.SkillProposal
	retro.json(&proposal, "propose", rkey, "--skill", "qa-acme", "--base", "1", "--file", writeFile(t, filepath.Join(work, "v2.md"), body))
	if proposal.State != client.Pending || proposal.AuthorID != retro.id || proposal.BasedOnVersion != 1 {
		t.Fatalf("proposal %+v", proposal)
	}
	retro.ok("handover", rkey, "--skill", "skill-review", "--note", "qa-acme v2 adds the empty basket")

	// The author holds skill-review but may not publish their own proposal.
	if slices.Contains(takeableKeys(retro), rkey) {
		t.Fatal("retro can take the review of its own proposal")
	}
	retro.refused(3, client.ErrorCodeNotTakeable, "claim", rkey, "--timeout", "1m")

	// reviewer, in another Team, reads the proposal and publishes it.
	var reviewTask client.TaskDetail
	reviewer.json(&reviewTask, "next", "--wait", "5s", "--timeout", "2m")
	if reviewTask.Task.Key != rkey {
		t.Fatalf("reviewer took %s", reviewTask.Task.Key)
	}
	var shown client.SkillProposal
	reviewer.json(&shown, "proposal", "show", rkey)
	if shown.ID != proposal.ID || shown.Body != body || shown.State != client.Pending {
		t.Fatalf("the proposal under review %+v", shown)
	}
	reviewer.ok("complete", rkey, "--note", "published")
	var v2 client.SkillDetail
	ada.json(&v2, "skill", "show", "qa-acme")
	if v2.Skill.CurrentVersion != 2 || v2.Current.Body != body || *v2.Current.PublishedBy != reviewer.id || *v2.Current.ProposalID != proposal.ID {
		t.Fatalf("qa-acme %+v", v2)
	}
	var versions client.SkillVersionList
	ada.json(&versions, "skill", "versions", "qa-acme")
	if len(versions.Items) != 2 {
		t.Fatalf("qa-acme has %d versions", len(versions.Items))
	}

	// The Observations are reviewed by the Retrospective.
	retro.json(&unreviewed, "feature", "observations", fkey)
	if len(unreviewed.Items) != 0 {
		t.Fatalf("still unreviewed %+v", unreviewed.Items)
	}
	var all client.ObservationList
	retro.json(&all, "feature", "observations", fkey, "--all")
	for _, o := range all.Items {
		if o.ReviewedByTaskID == nil || *o.ReviewedByTaskID != retroTask.ID {
			t.Fatalf("Observation %+v", o)
		}
	}

	// A Feature filed from the Retrospective records it; a qa Claim now works under version 2.
	var fix client.FeatureDetail
	retro.json(&fix, "feature", "create", "--team", "WEB", "--title", "Empty baskets", "--owner", "ada", "--from-retro", rkey)
	if fix.Feature.FromRetrospectiveTaskID == nil || *fix.Feature.FromRetrospectiveTaskID != retroTask.ID || fix.Feature.OwnerID != ada.id {
		t.Fatalf("filed %+v", fix.Feature)
	}
	var check client.TaskDetail
	ada.json(&check, "file", "--feature", fix.Feature.Key, "--title", "Test an empty basket", "--skill", "qa-acme")
	var later client.TaskDetail
	qa.json(&later, "claim", check.Task.Key, "--timeout", "2m", "--model", qaModel)
	if c := later.Task.Claim; c == nil || c.SkillVersion == nil || *c.SkillVersion != 2 || c.ModelLabel == nil || *c.ModelLabel != qaModel {
		t.Fatalf("a later qa Claim %+v", later.Task.Claim)
	}
	qa.ok("release", check.Task.Key, "--note", "next week")

	// Activity records it all, in order, with the model labels on the claims.
	var act client.ActivityPage
	ada.json(&act, "activity", "--all", "--limit", "500")
	seen := map[client.ActivityKind]int{}
	for i, en := range act.Items {
		seen[en.Kind]++
		if en.Seq != int64(i+1) {
			t.Fatalf("Activity entry %d has seq %d", i, en.Seq)
		}
		if area, _, _ := strings.Cut(string(en.Kind), "."); area != string(en.SubjectType) {
			t.Errorf("entry %d: %s about a %s", en.Seq, en.Kind, en.SubjectType)
		}
	}
	for _, k := range []client.ActivityKind{client.ActivityKindFeatureFiled, client.ActivityKindTaskClaimed, client.ActivityKindTaskHandedOver,
		client.ActivityKindTaskObserved, client.ActivityKindTaskNoteAdded, client.ActivityKindTaskEvidenceAttached,
		client.ActivityKindTaskBlockerAdded, client.ActivityKindFeatureShipped, client.ActivityKindTaskSkillProposed,
		client.ActivityKindSkillVersionPublished, client.ActivityKindTaskCompleted, client.ActivityKindTaskReleased} {
		if seen[k] == 0 {
			t.Errorf("no %s in Activity", k)
		}
	}
	labels := 0
	for _, en := range act.Items {
		if en.Kind == client.ActivityKindTaskClaimed && (en.Payload["model_label"] == engModel || en.Payload["model_label"] == qaModel) {
			labels++
		}
	}
	if labels != 5 {
		t.Errorf("%d claims recorded a model label, want 5", labels)
	}
}

func takeableKeys(m *member) []string {
	m.in.t.Helper()
	var list client.TaskList
	m.json(&list, "takeable")
	var keys []string
	for _, tk := range list.Items {
		keys = append(keys, tk.Key)
	}
	return keys
}

func skillID(t *testing.T, m *member, name string) string {
	t.Helper()
	var s client.SkillDetail
	m.json(&s, "skill", "show", name)
	return s.Skill.ID
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
