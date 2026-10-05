package e2e

import (
	"encoding/json"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/tuongaz/darkory/client"
)

// An agent works as the rules tell it: a Session from prime, a background heartbeat, then next,
// with its token's 5 s heartbeat timeout. Its heartbeat process is killed (kill -9), so its Claim
// lapses; another Session of the same Member can then claim the Task, and then another Member.
// The killed agent's late Heartbeat is told the Claim lapsed (exit 3), and Activity records the
// lapse once.
func TestLapseAndRecovery(t *testing.T) {
	in := newInstall(t)
	ada := in.ada
	ada.ok("team", "create", "WEB", "Web")
	ada.ok("team", "add", "WEB", "ada")
	ada.ok("skill", "create", "build", "--kind", "generic", "--body", "Build it.")
	a1 := in.agent("a1", []string{"WEB"}, []string{"build"}, "--timeout", "5s")
	a2 := in.agent("a2", []string{"WEB"}, []string{"build"})
	var feature client.FeatureDetail
	ada.json(&feature, "feature", "create", "--team", "WEB", "--title", "Search")
	var task client.TaskDetail
	ada.json(&task, "file", "--feature", feature.Feature.Key, "--title", "Index the catalogue", "--skill", "build")
	key := task.Task.Key

	// The background heartbeat starts before the Claim it keeps.
	out := a1.ok("heartbeat", "run", "--background")
	m := regexp.MustCompile(`\(pid (\d+)\)`).FindStringSubmatch(out)
	if m == nil {
		t.Fatalf("heartbeat run --background printed %q", out)
	}
	pid, _ := strconv.Atoi(m[1])
	proc, err := os.FindProcess(pid)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { proc.Kill() })

	var claimed client.TaskDetail
	a1.json(&claimed, "next", "--wait", "5s")
	if claimed.Task.Key != key || claimed.Task.Claim.HeartbeatTimeoutSeconds == nil || *claimed.Task.Claim.HeartbeatTimeoutSeconds != 5 {
		t.Fatalf("a1 took %+v", claimed.Task)
	}
	// The heartbeat keeps the Claim alive well past its timeout.
	time.Sleep(12 * time.Second)
	var shown client.TaskDetail
	ada.json(&shown, "show", key)
	if c := shown.Task.Claim; c == nil || c.ID != claimed.Task.Claim.ID || !c.ExpiresAt.After(time.Now()) {
		t.Fatalf("the background heartbeat did not keep the Claim: %+v (Claims %+v)\n%s", shown.Task.Claim, shown.Claims, heartbeatLog(t, in))
	}

	// The agent's heartbeat dies without a word; the Claim lapses at its expiry.
	if err := proc.Signal(syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	killed := time.Now()
	deadline := time.Now().Add(10 * time.Second)
	for {
		ada.json(&shown, "show", key)
		if shown.Task.Claim == nil {
			break
		}
		if time.Now().After(deadline) {
			out, _ := exec.Command("ps", "-o", "pid,stat,command", "-p", strconv.Itoa(pid)).CombinedOutput()
			t.Fatalf("the Claim did not lapse within 10 s of the kill: %+v\nps: %s\n%s\nserver:\n%s", shown.Task.Claim, out, heartbeatLog(t, in), in.servers[0].log)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if c := shown.Claims[0]; c.HowEnded == nil || *c.HowEnded != client.ClaimEndLapsed || c.EndedAt == nil {
		t.Fatalf("the Claim ended %+v", c)
	}
	t.Logf("the Claim lapsed %s after the heartbeat was killed", time.Since(killed).Round(100*time.Millisecond))

	// Another Session of the same Member may claim it, then another Member.
	again := a1.sibling()
	var reclaimed client.TaskDetail
	again.json(&reclaimed, "claim", key)
	if reclaimed.Task.Claim.SessionID != again.session || reclaimed.Task.Claim.HolderID != a1.id {
		t.Fatalf("a1's other Session took %+v", reclaimed.Task.Claim)
	}
	again.ok("release", key, "--note", "picking up something else")
	var other client.TaskDetail
	a2.json(&other, "claim", key, "--timeout", "1m")
	if other.Task.Claim.HolderID != a2.id {
		t.Fatalf("a2 took %+v", other.Task.Claim)
	}

	// The killed agent's late Heartbeat is refused: its Claim lapsed, and a2's is untouched.
	res := a1.run("heartbeat", key, "--json")
	var hb client.HeartbeatReply
	if res.code != 3 || json.Unmarshal([]byte(res.stdout), &hb) != nil || hb.Status != client.HeartbeatStatusLapsed {
		t.Fatalf("the late Heartbeat: exit %d\n%s%s", res.code, res.stdout, res.stderr)
	}
	ada.json(&shown, "show", key)
	if shown.Task.Claim == nil || shown.Task.Claim.HolderID != a2.id {
		t.Fatalf("after the late Heartbeat: %+v", shown.Task.Claim)
	}

	// Activity records the lapse once, with no actor.
	var act client.ActivityPage
	ada.json(&act, "activity", "--all", "--limit", "500")
	lapses := 0
	for _, en := range act.Items {
		if en.Kind == client.ActivityKindTaskLapsed && en.SubjectID == task.Task.ID {
			lapses++
			if en.ActorID != nil || en.Payload["claim_id"] != claimed.Task.Claim.ID {
				t.Errorf("the lapse entry %+v", en)
			}
		}
	}
	if lapses != 1 {
		t.Fatalf("Activity records %d lapses", lapses)
	}
}

// darkory mcp keeps the Claims its Session makes alive with Heartbeats for as long as it runs;
// once it is killed, the Claim lapses and is recorded.
func TestMCPKeepsItsClaimsAlive(t *testing.T) {
	in := newInstall(t)
	ada := in.ada
	ada.ok("team", "create", "WEB", "Web")
	ada.ok("team", "add", "WEB", "ada")
	ada.ok("skill", "create", "build", "--kind", "generic", "--body", "Build it.")
	agent := in.agent("agent", []string{"WEB"}, []string{"build"})
	var feature client.FeatureDetail
	ada.json(&feature, "feature", "create", "--team", "WEB", "--title", "Search")
	var task client.TaskDetail
	ada.json(&task, "file", "--feature", feature.Feature.Key, "--title", "Index the catalogue", "--skill", "build")

	mcp := agent.mcp(t.TempDir())
	var took struct {
		Claimed bool              `json:"claimed"`
		Task    client.TaskDetail `json:"task"`
	}
	mcp.call("next", map[string]any{"wait_seconds": 5, "heartbeat_timeout_seconds": 3}, &took)
	if !took.Claimed || took.Task.Task.Key != task.Task.Key {
		t.Fatalf("the MCP agent took %+v", took)
	}
	time.Sleep(8 * time.Second)
	var shown client.TaskDetail
	ada.json(&shown, "show", task.Task.Key)
	if c := shown.Task.Claim; c == nil || c.ID != took.Task.Task.Claim.ID || !c.ExpiresAt.After(time.Now()) {
		t.Fatalf("darkory mcp did not keep its Claim: %+v\n%s", shown.Claims, mcp.log)
	}

	if err := mcp.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	eventually(t, 6*time.Second, "the lapse", func() bool {
		ada.json(&shown, "show", task.Task.Key)
		return shown.Task.Claim == nil && len(shown.Claims) == 1 && shown.Claims[0].HowEnded != nil
	})
	if *shown.Claims[0].HowEnded != client.ClaimEndLapsed {
		t.Fatalf("the Claim ended %s", *shown.Claims[0].HowEnded)
	}
}

// heartbeatLog returns what the background heartbeats of an Install logged.
func heartbeatLog(t *testing.T, in *install) string {
	t.Helper()
	logs, _ := filepathGlob(in.dir, "heartbeat-*.log")
	var out string
	for _, l := range logs {
		b, _ := os.ReadFile(l)
		out += l + ":\n" + string(b)
	}
	return out
}
