package cli

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tuongaz/darkory/internal/cli/remote"
)

// cmdHeartbeatRun heartbeats every Claim this Session holds with a heartbeat timeout, at a third
// of the timeout, until it is stopped: for agents that work between calls (ADR 0005). With
// --background it starts itself detached, writing its pid and log under the user cache directory.
func cmdHeartbeatRun(c *call) error {
	background := c.fs.Bool("background", false, "run detached, with a pid file and log under the user cache directory")
	watch := c.fs.Int("watch-pid", 0, "stop when this process exits, such as the agent's own")
	if _, err := c.args(0, 0); err != nil {
		return err
	}
	conn, err := c.dial(lasting)
	if err != nil {
		return err
	}
	files, err := heartbeatFiles(conn.Settings)
	if err != nil {
		return err
	}
	if *background {
		return c.startBackground(conn.Settings, files, *watch)
	}

	ctx := c.ctx
	if *watch > 0 {
		var cancel func()
		ctx, cancel = watchProcess(ctx, *watch)
		defer cancel()
	}
	// A detached copy owns its pid file: its starter wrote it too, so that a second --background
	// sees it at once, and the copy removes it as it ends unless another has taken it.
	if path := c.env.Getenv(envPidFile); path != "" {
		if err := os.WriteFile(path, []byte(strconv.Itoa(os.Getpid())+"\n"), 0o600); err != nil {
			return err
		}
		defer func() {
			if pid, err := readPid(path); err == nil && pid == os.Getpid() {
				os.Remove(path)
			}
		}()
	}
	var mu sync.Mutex
	logf := func(format string, a ...any) {
		mu.Lock()
		defer mu.Unlock()
		fmt.Fprintf(c.out(), "%s "+format+"\n", append([]any{time.Now().UTC().Format(time.RFC3339)}, a...)...)
	}
	k := &remote.Keeper{
		Conn:     conn,
		OnNotice: func(n remote.Notice) { logf("%s", n) },
		OnError:  func(err error) { logf("%v; trying again", err) },
	}
	k.Every = heartbeatEvery
	logf("keeping this Session's Claims alive (Session %s); stop with darkory heartbeat stop or Ctrl-C", conn.Settings.Session)
	err = k.Run(ctx)
	if errors.Is(err, remote.ErrStopped) {
		logf("%v", err)
		return err
	}
	return nil
}

// envPidFile tells a detached `heartbeat run` which pid file is its own.
const envPidFile = "DARKORY_HEARTBEAT_PIDFILE"

// heartbeatEvery is a third of the timeout (tests shorten it).
var heartbeatEvery func(time.Duration) time.Duration

// bgFiles are where a background heartbeat keeps its pid and log.
type bgFiles struct{ pid, log string }

// heartbeatFiles names a Session's background heartbeat files, one pair per Install and Session.
func heartbeatFiles(s remote.Settings) (bgFiles, error) {
	dir, err := heartbeatDir()
	if err != nil {
		return bgFiles{}, err
	}
	sum := sha256.Sum256([]byte(strings.TrimRight(s.URL, "/") + "\n" + s.Session))
	base := filepath.Join(dir, "heartbeat-"+hex.EncodeToString(sum[:8]))
	return bgFiles{pid: base + ".pid", log: base + ".log"}, nil
}

// heartbeatDir is where background heartbeats keep their files (tests move it).
var heartbeatDir = func() (string, error) {
	dir, err := os.UserCacheDir()
	if err != nil {
		return "", fmt.Errorf("no user cache directory for the pid file: %w", err)
	}
	return filepath.Join(dir, "darkory"), nil
}

func readPid(path string) (int, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(b)))
}

// running returns the pid of the Session's background heartbeat, or 0 when none runs.
func running(files bgFiles) int {
	pid, err := readPid(files.pid)
	if err != nil || pid <= 0 || !processAlive(pid) {
		return 0
	}
	return pid
}

func (c *call) startBackground(s remote.Settings, files bgFiles, watch int) error {
	if pid := running(files); pid != 0 {
		fmt.Fprintf(c.out(), "This Session's heartbeat already runs in the background (pid %d); log: %s\n", pid, files.log)
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(files.pid), 0o700); err != nil {
		return err
	}
	exe := c.env.Executable
	if exe == "" {
		var err error
		if exe, err = os.Executable(); err != nil {
			return err
		}
	}
	logf, err := os.OpenFile(files.log, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer logf.Close()
	args := []string{"heartbeat", "run"}
	if watch > 0 {
		args = append(args, "--watch-pid", strconv.Itoa(watch))
	}
	cmd := exec.Command(exe, args...)
	// The settings go by the environment, which other users cannot read, rather than arguments.
	cmd.Env = append(os.Environ(), remote.EnvURL+"="+s.URL, remote.EnvToken+"="+s.Token,
		remote.EnvSession+"="+s.Session, envPidFile+"="+files.pid, "DARKORY_NO_UPDATE_CHECK=1")
	cmd.Stdout, cmd.Stderr = logf, logf
	detach(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	pid := cmd.Process.Pid
	if err := os.WriteFile(files.pid, []byte(strconv.Itoa(pid)+"\n"), 0o600); err != nil {
		_ = cmd.Process.Kill()
		return err
	}
	_ = cmd.Process.Release()
	fmt.Fprintf(c.out(), "Heartbeats for Session %s run in the background (pid %d); log: %s\nStop them with darkory heartbeat stop, or darkory session close.\n",
		s.Session, pid, files.log)
	return nil
}

func cmdHeartbeatStop(c *call) error {
	if _, err := c.args(0, 0); err != nil {
		return err
	}
	conn, err := c.dial(lasting)
	if err != nil {
		return err
	}
	stopped, err := stopBackground(conn.Settings)
	if err != nil {
		return err
	}
	if stopped == 0 {
		fmt.Fprintln(c.out(), "No background heartbeat runs for this Session.")
		return nil
	}
	fmt.Fprintf(c.out(), "Stopped this Session's background heartbeat (pid %d).\n", stopped)
	return nil
}

// stopBackground stops the Session's background heartbeat, returning its pid, or 0 when none ran.
func stopBackground(s remote.Settings) (int, error) {
	files, err := heartbeatFiles(s)
	if err != nil {
		return 0, err
	}
	pid := running(files)
	if pid == 0 {
		os.Remove(files.pid)
		return 0, nil
	}
	if err := terminate(pid); err != nil {
		return 0, err
	}
	os.Remove(files.pid)
	return pid, nil
}
