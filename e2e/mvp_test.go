package e2e

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/client"
)

// webFlow is the MVP flow's Workflow: a Breakdown at Plan, then Build, QA, UI review and Security
// review, each passing to the next and QA failing back to Build; a Retrospective at Retro, whose
// proposal goes to Skill review.
const webFlow = `{"workflows": [{"name": "Work", "position": 1}], "steps": [
  {"workflow": "Work", "name": "Backlog", "position": 1},
  {"workflow": "Work", "name": "Plan", "skill": "breakdown", "position": 2},
  {"workflow": "Work", "name": "Build", "skill": "build", "position": 3},
  {"workflow": "Work", "name": "QA", "skill": "qa-acme", "position": 4},
  {"workflow": "Work", "name": "UI review", "skill": "ui-review", "position": 5},
  {"workflow": "Work", "name": "Security review", "skill": "security-review", "position": 6},
  {"workflow": "Work", "name": "Retro", "skill": "retro", "position": 7},
  {"workflow": "Work", "name": "Skill review", "skill": "skill-review", "position": 8}],
 "connectors": [
  {"from": "Plan", "name": "done", "position": 1},
  {"from": "Build", "to": "QA", "name": "pass", "position": 1},
  {"from": "QA", "to": "UI review", "name": "pass", "position": 1},
  {"from": "QA", "to": "Build", "name": "fail", "position": 2},
  {"from": "UI review", "to": "Security review", "name": "pass", "position": 1},
  {"from": "Security review", "name": "pass", "position": 1},
  {"from": "Retro", "name": "done", "position": 1},
  {"from": "Retro", "to": "Skill review", "name": "propose", "position": 2},
  {"from": "Skill review", "name": "publish", "position": 1},
  {"from": "Skill review", "to": "Retro", "name": "needs changes", "position": 2}]}`

// The six steps of the MVP flow (map, "MVP flow the architecture must support") through the real
// binary, with a human Owner and six agent Members, each with its own token and Session, on a
// Workflow of Steps:
//
//  1. Members are specialists with Skills.
//  2. The human files a Task with Break down; eng, through darkory mcp, takes its Breakdown and
//     files the Subtasks.
//  3. eng builds through the CLI and advances to QA, which eng may not take; qa asks the Owner a
//     blocking question and keeps its Claim, then verifies and advances to UI review; uiux
//     advances to Security review; sec advances into Done.
//  4. The Subtask carries a test report and a screenshot.
//  5. The Owner completes the Parent, refused while Subtasks were open.
//  6. The Retrospective reads the Observations and proposes qa-acme v2, which its author may not
//     publish and a reviewer from another Project does; a Task filed from it records the link,
//     and a later qa Claim works under version 2.
func TestMVPFlow(t *testing.T) {
	in := newInstall(t)
	ada := in.ada
	work := t.TempDir()
	const engModel, qaModel = "claude-opus-5-5", "claude-sonnet-5-5"

	// 1. The Organisation: two Projects, the Skills, and the specialists.
	for _, s := range [][]string{
		{"build", "--kind", "generic", "--body", "Build it."},
		{"qa-acme", "--kind", "own", "--base", "qa", "--body", "Test the happy path in the browser."},
		{"ui-review", "--kind", "generic", "--body", "Review the screens."},
		{"security-review", "--kind", "generic", "--body", "Review for security."},
	} {
		ada.ok(append([]string{"skill", "create"}, s...)...)
	}
	in.project("WEB", "Web", webFlow)
	in.project("OPS", "Ops", "")
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

	// 2. The human files the Task with Break down, which comes with its Breakdown at Plan.
	var parent client.TaskDetail
	ada.json(&parent, "file", "--project", "WEB", "--title", "Checkout", "--body", "Customers pay for their basket.", "--breakdown")
	pkey := parent.Task.Key
	if parent.Task.OwnerID != ada.id || len(parent.Subtasks) != 1 || parent.Subtasks[0].Kind != client.Breakdown || parent.Task.StepID != nil {
		t.Fatalf("filed %+v with %+v", parent.Task, parent.Subtasks)
	}
	ada.refused(3, client.ErrorCodeTasksOpen, "complete", pkey)

	// eng, through darkory mcp, takes the Breakdown and files the Subtasks with their order.
	mcp := eng.mcp(work)
	var took struct {
		Claimed bool              `json:"claimed"`
		Task    client.TaskDetail `json:"task"`
	}
	mcp.call("next", map[string]any{"wait_seconds": 5, "heartbeat_timeout_seconds": 60, "model_label": engModel}, &took)
	bd := took.Task.Task
	if !took.Claimed || bd.Kind != client.Breakdown || bd.Claim == nil || bd.Claim.SessionID != short(eng.session) ||
		bd.Claim.ModelLabel == nil || *bd.Claim.ModelLabel != engModel || took.Task.Step == nil || took.Task.Step.Name != "Plan" {
		t.Fatalf("eng took %+v", took)
	}
	var build, receipt client.TaskDetail
	mcp.call("file_task", map[string]any{"parent": pkey, "title": "Build checkout",
		"description": "The form at /checkout and the call to the payment provider."}, &build)
	mcp.call("file_task", map[string]any{"parent": pkey, "title": "Send the receipt"}, &receipt)
	if build.Step == nil || build.Step.Name != "Build" || build.Parent == nil || build.Parent.Key != pkey {
		t.Fatalf("the Subtask %+v at %+v", build.Parent, build.Step)
	}
	mcp.call("block", map[string]any{"task": receipt.Task.Key, "blocker": build.Task.Key}, nil)
	mcp.refused("block", map[string]any{"task": build.Task.Key, "blocker": receipt.Task.Key}, client.ErrorCodeCycle)
	mcp.call("advance", map[string]any{"task": bd.Key, "note": "two Subtasks; the receipt waits for checkout"}, nil)
	mcp.close()
	ada.json(&parent, "show", pkey)
	if n := parent.Task.SubtaskCounts; n == nil || *n != (client.SubtaskCounts{Open: 2, Done: 1}) {
		t.Fatalf("after the Breakdown: %+v", parent.Task.SubtaskCounts)
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
	// Build has no way into Done: complete is refused, naming the outcomes.
	if e := eng.refused(3, client.ErrorCodeUseAdvance, "complete", bkey); e.Details == nil || fmt.Sprint((*e.Details)["outcomes"]) != "[pass]" {
		t.Fatalf("complete at Build: %+v", e)
	}
	var handed client.Task
	eng.json(&handed, "advance", bkey, "pass", "--note", "ready for qa")
	if handed.Claim != nil || handed.SkillID == nil || *handed.SkillID != skillID(t, ada, "qa-acme") {
		t.Fatalf("advanced %+v", handed)
	}

	// eng holds qa-acme, but no one judges their own work.
	if slices.Contains(takeableKeys(eng), bkey) {
		t.Fatal("eng can take the QA of its own Task")
	}
	eng.refused(3, client.ErrorCodeNotTakeable, "claim", bkey, "--timeout", "1m")

	// qa takes it, gets stuck, and asks the Owner, keeping its Claim; the question lands beside
	// the Task, under its Parent.
	var verifying client.TaskDetail
	qa.json(&verifying, "next", "--wait", "5s", "--timeout", "2m", "--model", qaModel)
	if verifying.Task.Key != bkey || *verifying.Task.Claim.SkillVersion != 1 || len(verifying.Notes) != 2 || len(verifying.Observations) != 1 {
		t.Fatalf("qa took %+v with %d Notes", verifying.Task, len(verifying.Notes))
	}
	var question client.TaskDetail
	qa.json(&question, "file", "--title", "Should an empty basket show an error?", "--aim", "ada", "--blocks", bkey)
	qkey := question.Task.Key
	if question.Task.ParentID == nil || *question.Task.ParentID != parent.Task.ID || question.Task.AimedAtID == nil || *question.Task.AimedAtID != ada.id ||
		question.Task.StepID != nil || len(question.Blocking) != 1 || question.Blocking[0].Key != bkey {
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
		t.Fatal("the Owner cannot take the question aimed at them")
	}
	var answering client.TaskDetail
	ada.json(&answering, "claim", qkey, "--timeout", "0")
	if answering.Task.Claim.HeartbeatTimeoutSeconds != nil || answering.Task.Claim.SkillID != nil {
		t.Fatalf("the Owner's Claim on the question %+v", answering.Task.Claim)
	}
	ada.ok("complete", qkey, "--note", "Yes: show 'Your basket is empty' and no pay button.")
	qa.json(&held, "show", bkey)
	if held.Task.Blocked || held.Task.Claim == nil || held.Task.Claim.HolderID != qa.id {
		t.Fatalf("qa's Task once answered %+v", held.Task)
	}

	// 4. qa verifies, with a test report and a screenshot, and advances to UI review.
	qa.ok("note", bkey, "an empty basket shows the message, per the Owner")
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
	qa.ok("observe", bkey, "--worked", "the Owner answered the question within minutes")
	qa.refused(3, client.ErrorCodeNoConnector, "advance", bkey)
	qa.json(&handed, "advance", bkey, "pass")

	// uiux reviews and advances to Security review; sec advances into Done.
	var reviewing client.TaskDetail
	uiux.json(&reviewing, "next", "--wait", "5s", "--timeout", "2m")
	if reviewing.Task.Key != bkey || len(reviewing.Evidence) != 3 || reviewing.Step == nil || reviewing.Step.Name != "UI review" {
		t.Fatalf("uiux took %+v with %d Evidence", reviewing.Task, len(reviewing.Evidence))
	}
	uiux.ok("advance", bkey, "--note", "the empty-basket message reads well")
	sec.json(&reviewing, "next", "--wait", "5s", "--timeout", "2m")
	if reviewing.Task.Key != bkey {
		t.Fatalf("sec took %s", reviewing.Task.Key)
	}
	var done client.Task
	sec.json(&done, "advance", bkey, "pass", "--note", "no secrets in the form")
	if done.State != client.TaskStateDone || done.Claim != nil || done.StepID != nil {
		t.Fatalf("advanced into Done %+v", done)
	}

	// 5. The receipt is still open, so the Owner cannot complete the Parent yet; it goes through
	// every Step in turn, and the QA fails it back to Build once.
	ada.refused(3, client.ErrorCodeTasksOpen, "complete", pkey)
	var second client.TaskDetail
	eng.json(&second, "next", "--wait", "5s", "--timeout", "2m", "--model", engModel)
	rkeyTask := receipt.Task.Key
	if second.Task.Key != rkeyTask || second.Task.Blocked {
		t.Fatalf("eng then took %+v", second.Task)
	}
	eng.ok("advance", rkeyTask, "pass")
	qa.ok("next", "--wait", "5s", "--timeout", "2m", "--model", qaModel)
	qa.ok("advance", rkeyTask, "fail", "--note", "the receipt has no total")
	eng.ok("next", "--wait", "5s", "--timeout", "2m", "--model", engModel)
	eng.ok("advance", rkeyTask, "pass", "--note", "added the total")
	qa.ok("next", "--wait", "5s", "--timeout", "2m", "--model", qaModel)
	qa.ok("advance", rkeyTask, "pass")
	uiux.ok("next", "--wait", "5s", "--timeout", "2m")
	uiux.ok("advance", rkeyTask)
	sec.ok("next", "--wait", "5s", "--timeout", "2m")
	sec.ok("advance", rkeyTask)

	var record client.TaskDetail
	ada.json(&record, "show", bkey)
	if len(record.Claims) != 4 || len(record.Evidence) != 3 || len(record.Observations) != 2 || len(record.Notes) != 5 {
		t.Fatalf("the record: %d Claims, %d Evidence, %d Observations, %d Notes", len(record.Claims), len(record.Evidence),
			len(record.Observations), len(record.Notes))
	}
	if c := record.Claims[1]; c.HolderID != qa.id || *c.SkillVersion != 1 || *c.ModelLabel != qaModel || *c.HowEnded != client.ClaimEndAdvanced {
		t.Fatalf("qa's Claim %+v", c)
	}
	var completed client.Task
	ada.json(&completed, "complete", pkey)
	if completed.State != client.TaskStateDone {
		t.Fatalf("completed %+v", completed)
	}
	ada.json(&parent, "show", pkey)
	retroTask := parent.Subtasks[len(parent.Subtasks)-1]
	if retroTask.Kind != client.Retrospective || retroTask.Title != "Retrospective: Checkout" || retroTask.State != client.TaskStateOpen ||
		retroTask.FiledBy != nil {
		t.Fatalf("completing filed %+v", retroTask)
	}
	rkey := retroTask.Key

	// 6. retro reads the Observations and proposes qa-acme v2.
	var r client.TaskDetail
	retro.json(&r, "next", "--wait", "5s", "--timeout", "2m")
	if r.Task.Key != rkey || r.Step == nil || r.Step.Name != "Retro" {
		t.Fatalf("retro took %s, want %s", r.Task.Key, rkey)
	}
	var unreviewed client.ObservationList
	retro.json(&unreviewed, "observations", pkey)
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
	retro.ok("advance", rkey, "propose", "--note", "qa-acme v2 adds the empty basket")

	// The author holds skill-review but may not publish their own proposal.
	if slices.Contains(takeableKeys(retro), rkey) {
		t.Fatal("retro can take the review of its own proposal")
	}
	retro.refused(3, client.ErrorCodeNotTakeable, "claim", rkey, "--timeout", "1m")

	// reviewer, in another Project, reads the proposal and publishes it.
	var reviewTask client.TaskDetail
	reviewer.json(&reviewTask, "next", "--wait", "5s", "--timeout", "2m")
	if reviewTask.Task.Key != rkey {
		t.Fatalf("reviewer took %s", reviewTask.Task.Key)
	}
	var shown []client.SkillProposal
	reviewer.json(&shown, "proposal", "show", rkey)
	if len(shown) != 1 || shown[0].ID != proposal.ID || shown[0].Body != body || shown[0].State != client.Pending {
		t.Fatalf("the proposal under review %+v", shown)
	}
	reviewer.ok("advance", rkey, "publish", "--note", "published")
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
	retro.json(&unreviewed, "observations", pkey)
	if len(unreviewed.Items) != 0 {
		t.Fatalf("still unreviewed %+v", unreviewed.Items)
	}
	var all client.ObservationList
	retro.json(&all, "observations", pkey, "--all")
	for _, o := range all.Items {
		if o.ReviewedByTaskID == nil || *o.ReviewedByTaskID != retroTask.ID {
			t.Fatalf("Observation %+v", o)
		}
	}

	// A Task filed from the Retrospective records it; a qa Claim now works under version 2.
	var fix client.TaskDetail
	retro.json(&fix, "file", "--project", "WEB", "--title", "Empty baskets", "--owner", "ada", "--from-retro", rkey)
	if fix.Task.FromRetrospectiveTaskID == nil || *fix.Task.FromRetrospectiveTaskID != retroTask.ID || fix.Task.OwnerID != ada.id || fix.Task.ParentID != nil {
		t.Fatalf("filed %+v", fix.Task)
	}
	var check client.TaskDetail
	ada.json(&check, "file", "--parent", fix.Task.Key, "--title", "Test an empty basket", "--step", "QA")
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
	for _, k := range []client.ActivityKind{client.ActivityKindProjectCreated, client.ActivityKindWorkflowChanged, client.ActivityKindTaskFiled,
		client.ActivityKindTaskClaimed, client.ActivityKindTaskAdvanced, client.ActivityKindTaskObserved, client.ActivityKindTaskNoteAdded,
		client.ActivityKindTaskEvidenceAttached, client.ActivityKindTaskBlockerAdded, client.ActivityKindTaskSkillProposed,
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
	if labels != 8 {
		t.Errorf("%d claims recorded a model label, want 8", labels)
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
