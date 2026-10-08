package e2e

import (
	"context"
	"encoding/json"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/tuongaz/darkory/client"
)

// Two serve processes on one Postgres database: an agent long-polling next on server A is woken
// within a second by a Task filed on server B, and activity --follow on A prints B's writes as
// they commit (ADR 0006).
func TestTwoServersOnePostgres(t *testing.T) {
	needE2E(t)
	if engine() != "postgres" {
		t.Skip("two server processes share a database only on Postgres (make e2e-pg)")
	}
	in := newInstall(t)
	a := in.servers[0]
	b := in.serve()
	ada := in.ada
	ada.ok("skill", "create", "build", "--kind", "generic", "--body", "Build it.")
	in.project("WEB", "Web", buildFlow)
	agent := in.agent("agent", []string{"WEB"}, []string{"build"}).on(a)
	adaB := ada.on(b)

	// Follow Activity on A from the latest entry, read first so nothing filed later is missed.
	var latest client.ActivityPage
	ada.on(a).json(&latest, "activity")
	follow := &logBuffer{}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "activity", "--follow", "--json", "--after", strconv.FormatInt(latest.LastSeq, 10))
	cmd.Env = ada.on(a).env()
	cmd.Stdout, cmd.Stderr = follow, follow
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cancel()
		cmd.Wait()
	}()

	var worst time.Duration
	for round := range 5 {
		// The agent waits on A, with nothing takeable.
		type outcome struct {
			res result
			at  time.Time
		}
		done := make(chan outcome, 1)
		go func() {
			res := agent.run("next", "--wait", "30s", "--timeout", "1m", "--json")
			done <- outcome{res, time.Now()}
		}()
		time.Sleep(1500 * time.Millisecond) // the long-poll is waiting by now

		var filed client.TaskDetail
		adaB.json(&filed, "file", "--project", "WEB", "--title", "Task "+strconv.Itoa(round))
		committed := time.Now()
		var got outcome
		select {
		case got = <-done:
		case <-time.After(10 * time.Second):
			t.Fatalf("round %d: next on A was not woken by the Task filed on B", round)
		}
		var claimed client.TaskDetail
		if got.res.code != 0 || json.Unmarshal([]byte(got.res.stdout), &claimed) != nil || claimed.Task.Key != filed.Task.Key {
			t.Fatalf("round %d: next on A: exit %d\n%s%s", round, got.res.code, got.res.stdout, got.res.stderr)
		}
		woke := got.at.Sub(committed)
		worst = max(worst, woke)
		if woke > time.Second {
			t.Errorf("round %d: next on A answered %s after the Task was filed on B", round, woke)
		}
		agent.ok("complete", filed.Task.Key)

		// A's stream prints B's write too.
		eventually(t, time.Second, "task.filed for "+filed.Task.Key+" on A's stream", func() bool {
			return strings.Contains(follow.String(), `"key":"`+filed.Task.Key+`"`)
		})
	}
	t.Logf("next on A woke at most %s after a Task was filed on B (including the CLI's start and exit)", worst.Round(time.Millisecond))

	// The stream printed every entry after the one read first, in order, with nothing missing.
	var now client.ActivityPage
	ada.json(&now, "activity")
	eventually(t, 2*time.Second, "the stream to catch up", func() bool {
		return strings.Contains(follow.String(), `"seq":`+strconv.FormatInt(now.LastSeq, 10)+",")
	})
	var seqs []int64
	dec := json.NewDecoder(strings.NewReader(follow.String()))
	for dec.More() {
		var en client.Activity
		if err := dec.Decode(&en); err != nil {
			t.Fatalf("activity --follow --json printed something else: %v\n%s", err, follow)
		}
		seqs = append(seqs, en.Seq)
	}
	if int64(len(seqs)) != now.LastSeq-latest.LastSeq {
		t.Fatalf("the stream printed %d entries, want %d", len(seqs), now.LastSeq-latest.LastSeq)
	}
	for i, s := range seqs {
		if s != latest.LastSeq+int64(i)+1 {
			t.Fatalf("the stream printed seq %d at position %d after %d", s, i, latest.LastSeq)
		}
	}
}
