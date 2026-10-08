package cli

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/cli/remote"
)

// latestSeq is past every sequence number, so `before` it reads the latest page (JavaScript's
// largest safe integer, as the contract suggests).
const latestSeq = 9007199254740991

func cmdActivity(c *call) error {
	after := c.fs.Int64("after", 0, "the entries after this sequence number, oldest first")
	before := c.fs.Int64("before", 0, "the entries just before this sequence number")
	all := c.fs.Bool("all", false, "from the first entry: the first page, or with --follow the whole history")
	limit := c.fs.Int("limit", 0, "at most this many entries (default 100); not with --follow")
	follow := c.fs.Bool("follow", false, "keep printing entries as they are written, from now unless --after or --all, until stopped")
	member := c.fs.String("member", "", "only entries this Member acted in, or that ended a Claim they held; not with --follow")
	kinds := c.fs.String("kind", "", "only entries of these kinds, separated by commas, such as task.claimed,task.lapsed; not with --follow")
	project := c.fs.String("project", "", "only entries about this Project, its Workflow, Labels and Tasks; not with --follow")
	task := c.fs.String("task", "", "only entries about this Task and, for a Parent, its Subtasks; not with --follow")
	if _, err := c.args(0, 0); err != nil {
		return err
	}
	set := map[string]bool{}
	c.fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	switch {
	case set["after"] && set["before"], *all && (set["after"] || set["before"]):
		return usagef("give one of --after, --before and --all")
	case *follow && set["before"]:
		return usagef("--follow reads forwards; use --after or --all")
	case *follow && set["limit"]:
		return usagef("--limit does not apply to --follow")
	case *follow && (*member != "" || *kinds != "" || *project != "" || *task != ""):
		return usagef("--member, --kind, --project and --task do not apply to --follow, which streams every entry")
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	if *follow {
		from := *after
		if !set["after"] && !*all {
			// From now, as the stream does by itself, but known, so a reconnect misses nothing.
			if from, err = c.lastSeq(conn); err != nil {
				return err
			}
		}
		return c.follow(conn, from)
	}
	params := &client.ListActivityParams{}
	switch {
	case set["after"] || *all:
		params.After = after
	case set["before"]:
		params.Before = before
	default:
		params.Before = ptr(int64(latestSeq))
	}
	if *limit > 0 {
		params.Limit = limit
	}
	params.Member, params.Project, params.Task = opt(*member), opt(*project), opt(*task)
	if *kinds != "" {
		var ks []client.ActivityKind
		for k := range strings.SplitSeq(*kinds, ",") {
			if k = strings.TrimSpace(k); k != "" {
				ks = append(ks, client.ActivityKind(k))
			}
		}
		params.Kind = &ks
	}
	res, err := conn.ListActivityWithResponse(c.ctx, params)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) {
		p := res.JSON200
		if len(p.Items) == 0 {
			fmt.Fprintln(w, "No Activity.")
		}
		for _, a := range p.Items {
			c.printActivity(w, a)
		}
		if p.FirstSeq != nil && *p.FirstSeq > 1 {
			fmt.Fprintf(w, "Earlier: --before %d. ", *p.FirstSeq)
		}
		fmt.Fprintf(w, "Later: --after %d.\n", p.LastSeq)
	})
}

// lastSeq is the sequence number of the latest Activity entry, or 0 when there is none.
func (c *call) lastSeq(conn *remote.Conn) (int64, error) {
	res, err := conn.ListActivityWithResponse(c.ctx, &client.ListActivityParams{Before: ptr(int64(latestSeq)), Limit: ptr(1)})
	if err := check(res, err, http.StatusOK); err != nil {
		return 0, err
	}
	return res.JSON200.LastSeq, nil
}

// follow prints the Activity stream from after, one entry per line (one JSON object per line
// with --json), opening it again from the last entry seen whenever it drops.
func (c *call) follow(conn *remote.Conn, after int64) error {
	backoff := time.Second
	for {
		last, err := c.stream(conn, after)
		if last > after {
			after, backoff = last, time.Second
		}
		if c.ctx.Err() != nil {
			return nil
		}
		var re *remote.Error
		if errors.As(err, &re) && re.Status != 0 {
			// The Install answered and refused: revoked, Session closed, bad request.
			return err
		}
		if err != nil && !c.g.json {
			fmt.Fprintf(c.errOut(), "darkory: the Activity stream dropped (%v); reopening after %d\n", err, after)
		}
		select {
		case <-c.ctx.Done():
			return nil
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

// stream reads one connection of the Activity stream, returning the last sequence number seen.
func (c *call) stream(conn *remote.Conn, after int64) (int64, error) {
	res, err := conn.ClientInterface.StreamActivity(c.ctx, &client.StreamActivityParams{After: &after})
	if err != nil {
		return after, check(nil, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(res.Body)
		return after, remote.ErrorFrom(res.StatusCode, b)
	}
	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
	var id, data string
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			if data != "" {
				if err := c.emitEvent(data); err != nil {
					return after, err
				}
				if n, err := strconv.ParseInt(id, 10, 64); err == nil {
					after = n
				}
			}
			id, data = "", ""
		case strings.HasPrefix(line, ":"):
		case strings.HasPrefix(line, "id:"):
			id = strings.TrimSpace(strings.TrimPrefix(line, "id:"))
		case strings.HasPrefix(line, "data:"):
			if data != "" {
				data += "\n"
			}
			data += strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " ")
		}
	}
	if err := sc.Err(); err != nil {
		return after, err
	}
	return after, io.ErrUnexpectedEOF
}

func (c *call) emitEvent(data string) error {
	if c.g.json {
		_, err := fmt.Fprintf(c.env.Stdout, "%s\n", remote.CleanJSON([]byte(data)))
		return err
	}
	var a client.Activity
	if err := json.Unmarshal([]byte(data), &a); err != nil {
		return fmt.Errorf("an Activity event that is not an Activity: %w", err)
	}
	c.printActivity(c.out(), a)
	return nil
}
