//go:build !windows

package runner

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// descendants lists the live processes under root, as ps shows them, with when each started (to
// the second), leaving out zombies, which have ended.
func descendants(ctx context.Context, root int) ([]proc, error) {
	out, err := exec.CommandContext(ctx, "ps", "-A", "-o", "pid=,ppid=,etime=,stat=,comm=").Output()
	if err != nil {
		return nil, err
	}
	now := time.Now()
	children := map[int][]proc{}
	for l := range strings.Lines(string(out)) {
		f := strings.Fields(l)
		if len(f) < 5 {
			continue
		}
		pid, err1 := strconv.Atoi(f[0])
		ppid, err2 := strconv.Atoi(f[1])
		age, err3 := parseEtime(f[2])
		if err1 != nil || err2 != nil || err3 != nil || strings.HasPrefix(f[3], "Z") {
			continue
		}
		children[ppid] = append(children[ppid], proc{PID: pid, Started: now.Add(-age), Command: strings.Join(f[4:], " ")})
	}
	var list []proc
	queue := []int{root}
	for len(queue) > 0 {
		for _, c := range children[queue[0]] {
			list = append(list, c)
			queue = append(queue, c.PID)
		}
		queue = queue[1:]
	}
	return list, nil
}

// parseEtime reads ps's elapsed time, [[dd-]hh:]mm:ss.
func parseEtime(s string) (time.Duration, error) {
	days := 0
	if d, rest, ok := strings.Cut(s, "-"); ok {
		n, err := strconv.Atoi(d)
		if err != nil {
			return 0, err
		}
		days, s = n, rest
	}
	var secs int
	for part := range strings.SplitSeq(s, ":") {
		n, err := strconv.Atoi(part)
		if err != nil {
			return 0, err
		}
		secs = secs*60 + n
	}
	return time.Duration(days)*24*time.Hour + time.Duration(secs)*time.Second, nil
}
