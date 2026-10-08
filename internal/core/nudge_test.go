package core_test

import (
	"strings"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// The Runner records each nudge through the Session holding the Task's Claim, on both engines: an
// entry with no actor naming the Claim, its holder and which nudge, numbered like any other; a
// retry under the same key records it once; another Session of the holder, another Member, a
// Task nobody holds and a nudge other than 1 or 2 are refused.
func TestRecordNudge(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newClaimFixture(t, st)
		ctx := t.Context()
		before := f.checkActivity()

		err := f.svc.RecordNudge(ctx, f.a, f.task.Key, 1, core.Idem{})
		wantCode(t, err, core.CodeNotHolder)

		d := f.claim(f.a, f.task.Key, timeout(time.Minute))
		if err := f.svc.RecordNudge(ctx, f.a, f.task.Key, 1, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		idem := jsonIdem("n2", "h2")
		for range 2 {
			err := f.svc.RecordNudge(ctx, f.a, f.task.ID, 2, idem)
			if a := answerOf(t, idem, nil, err); a.status != 200 {
				t.Fatalf("the second nudge: %d %s", a.status, a.body)
			}
		}
		for _, n := range []int{0, 3} {
			wantCode(t, f.svc.RecordNudge(ctx, f.a, f.task.Key, n, core.Idem{}), core.CodeInvalid)
		}
		wantCode(t, f.svc.RecordNudge(ctx, f.session(f.a.MemberID, "a-2"), f.task.Key, 1, core.Idem{}), core.CodeNotHolder)
		wantCode(t, f.svc.RecordNudge(ctx, f.b, f.task.Key, 1, core.Idem{}), core.CodeNotHolder)

		nudges := f.activity("task.nudged")
		if len(nudges) != 2 {
			t.Fatalf("%d nudges recorded", len(nudges))
		}
		for i, a := range nudges {
			if a.ActorID != nil || a.SubjectID != f.task.ID || a.Payload["holder_id"] != f.a.MemberID ||
				a.Payload["claim_id"] != d.Task.Claim.ID || a.Payload["nudge"] != float64(i+1) {
				t.Fatalf("nudge %d: %+v", i+1, a)
			}
		}
		if got := strings.Join(f.activityKinds(f.task.ID), " "); !strings.HasSuffix(got, "task.claimed task.nudged task.nudged") {
			t.Fatalf("the Task's Activity: %s", got)
		}
		// checkActivity holds the counter to the entries: each nudge took its number.
		if after := f.checkActivity(); after != before+3 {
			t.Fatalf("%d entries written, want the Claim and two nudges", after-before)
		}
		// The holder still holds the Task: a nudge records, it changes nothing.
		if got := f.get(f.task.Key); got.Task.Claim == nil || got.Task.Claim.ID != d.Task.Claim.ID {
			t.Fatalf("after the nudges: %+v", got.Task.Claim)
		}
	})
}
