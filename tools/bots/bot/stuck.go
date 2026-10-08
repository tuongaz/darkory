package bot

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/tuongaz/darkory/client"
)

// Stuck works through the real darkory binary (Config.Binary), as an agent in a shell does: it
// takes a Task with `darkory next`, keeps the Claim alive with `darkory heartbeat run`, and
// checks it every Pace.Heartbeat with `darkory heartbeat <task>`, never finishing. When someone
// on its Reporting line or the Task's Owner takes the Task back, `darkory heartbeat` exits 3
// with taken_back; Stuck then stops its heartbeat run, which has logged the take-back too, and
// reports both. With Pace.Rest zero it is done; otherwise it rests and takes work again.
type Stuck struct{ agent }

// NewStuck makes a stuck bot.
func NewStuck(cfg Config, m Member, model string) *Stuck {
	return &Stuck{agent: newAgent(cfg, m, model)}
}

func (s *Stuck) Run(ctx context.Context) error {
	return s.loop(ctx, func() (bool, error) {
		var d client.TaskDetail
		res := s.darkory(ctx, "next", "--wait", fmt.Sprintf("%ds", s.cfg.Pace.Wait), "--timeout", fmt.Sprintf("%ds", s.cfg.Pace.Timeout),
			"--model", s.model, "--json")
		switch {
		case ctx.Err() != nil:
			return false, nil
		case res.code == 4:
			return true, nil
		case res.code != 0:
			return true, res.err("next")
		}
		if err := json.Unmarshal([]byte(res.stdout), &d); err != nil {
			return true, fmt.Errorf("darkory next --json: %w", err)
		}
		s.took(&d)
		if !s.holdUntilTakenBack(ctx, &d) || s.cfg.Pace.Rest == 0 {
			return false, nil
		}
		sleep(ctx, s.cfg.Pace.Rest)
		return true, nil
	})
}

// holdUntilTakenBack heartbeats d's Task until a Heartbeat says the Claim is gone, and says
// whether that happened before ctx ended.
func (s *Stuck) holdUntilTakenBack(ctx context.Context, d *client.TaskDetail) bool {
	key := d.Task.Key
	kctx, stopKeeper := context.WithCancel(ctx)
	keeper := exec.CommandContext(kctx, s.cfg.Binary, "heartbeat", "run")
	keeper.Env = s.env()
	log := &lockedBuffer{}
	keeper.Stdout, keeper.Stderr = log, log
	keeper.Cancel = func() error { return keeper.Process.Signal(os.Interrupt) }
	keeper.WaitDelay = 5 * time.Second
	if err := keeper.Start(); err != nil {
		stopKeeper()
		s.fail(ctx, key, fmt.Errorf("darkory heartbeat run: %w", err))
		return false
	}
	exited := make(chan error, 1)
	go func() { exited <- keeper.Wait() }()
	defer func() {
		stopKeeper()
		<-exited
	}()
	s.say("heartbeating", key, "darkory heartbeat run keeps the Claim alive; darkory heartbeat %s checks it every %s", key, s.cfg.Pace.Heartbeat)

	for sleep(ctx, s.cfg.Pace.Heartbeat) {
		res := s.darkory(ctx, "heartbeat", key, "--json")
		if ctx.Err() != nil {
			return false
		}
		if res.code == 0 {
			continue
		}
		var reply client.HeartbeatReply
		if res.code != 3 || json.Unmarshal([]byte(res.stdout), &reply) != nil {
			s.fail(ctx, key, res.err("heartbeat "+key))
			continue
		}
		// The keeper heartbeats at a third of the timeout, so it meets the end within one.
		deadline := time.Now().Add(time.Duration(s.cfg.Pace.Timeout) * time.Second)
		notice := ""
		for notice == "" && time.Now().Before(deadline) && sleep(ctx, 50*time.Millisecond) {
			for _, line := range strings.Split(log.String(), "\n") {
				if strings.Contains(line, "your Claim on "+key) {
					notice = line
				}
			}
		}
		stopKeeper()
		what := strings.ReplaceAll(string(reply.Status), "_", " ")
		if s.cfg.Report != nil {
			s.cfg.Report(Event{At: time.Now(), Bot: s.m.Name, What: what, Task: key, Code: res.code,
				Text: fmt.Sprintf("darkory heartbeat %s exited %d (%s); darkory heartbeat run logged: %s", key, res.code, reply.Status, or(notice, "nothing"))})
		}
		return true
	}
	return false
}

func (s *Stuck) env() []string {
	env := s.cfg.Env
	if env == nil {
		env = os.Environ()
	}
	return append(env[:len(env):len(env)], "DARKORY_URL="+s.cfg.URL, "DARKORY_TOKEN="+s.m.Token, "DARKORY_SESSION="+s.m.Session,
		"DARKORY_NO_UPDATE_CHECK=1")
}

// cliResult is how a darkory command ended.
type cliResult struct {
	stdout, stderr string
	code           int
	runErr         error
}

func (r cliResult) err(what string) error {
	if r.runErr != nil {
		return fmt.Errorf("darkory %s: %w", what, r.runErr)
	}
	return fmt.Errorf("darkory %s: exit %d: %s", what, r.code, strings.TrimSpace(r.stderr))
}

// darkory runs the CLI as this bot, in its Session.
func (s *Stuck) darkory(ctx context.Context, args ...string) cliResult {
	cmd := exec.CommandContext(ctx, s.cfg.Binary, args...)
	cmd.Env = s.env()
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	var exit *exec.ExitError
	switch {
	case errors.As(err, &exit):
		return cliResult{stdout.String(), stderr.String(), exit.ExitCode(), nil}
	case err != nil:
		return cliResult{stdout.String(), stderr.String(), -1, err}
	}
	return cliResult{stdout.String(), stderr.String(), 0, nil}
}

// lockedBuffer collects a process's output as it is written.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}
