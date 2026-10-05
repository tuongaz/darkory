package cli

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/cli/remote"
)

func cmdActivity(c *call) error {
	after := c.fs.Int64("after", 0, "only entries after this sequence number")
	limit := c.fs.Int("limit", 0, "at most this many entries (default 100); not with --follow")
	follow := c.fs.Bool("follow", false, "keep printing entries as they happen, until stopped")
	if _, err := c.args(0, 0); err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	if *follow {
		return c.follow(conn, *after)
	}
	params := &client.ListActivityParams{After: after}
	if *limit > 0 {
		params.Limit = limit
	}
	res, err := conn.ListActivityWithResponse(c.ctx, params)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) {
		for _, a := range res.JSON200.Items {
			c.printActivity(w, a)
		}
		fmt.Fprintf(w, "Last: %d (pass --after %d for what follows)\n", res.JSON200.LastSeq, res.JSON200.LastSeq)
	})
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
