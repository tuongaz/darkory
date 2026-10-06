package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/server/gen"
)

func (s *Server) ListActivity(w http.ResponseWriter, r *http.Request, params gen.ListActivityParams) {
	var q core.ActivityQuery
	if params.After != nil {
		q.After = *params.After
	}
	if params.Before != nil {
		q.Before = *params.Before
		if q.Before < 1 {
			invalid(w, "before is 1 or more")
			return
		}
	}
	if q.After < 0 {
		invalid(w, "after is not negative")
		return
	}
	if params.Limit != nil {
		q.Limit = *params.Limit
	}
	if params.Member != nil {
		q.Member = *params.Member
	}
	if params.Team != nil {
		q.Team = *params.Team
	}
	if params.Kind != nil {
		for _, k := range *params.Kind {
			q.Kinds = append(q.Kinds, string(k))
		}
	}
	p, err := s.core.ListActivity(r.Context(), caller(r), q)
	s.respond(w, r, as(http.StatusOK, func(p core.ActivityPage) any {
		out := gen.ActivityPage{Items: each(p.Items, activityOut), LastSeq: p.LastSeq}
		if p.FirstSeq > 0 {
			out.FirstSeq = &p.FirstSeq
		}
		return out
	}), p, err)
}

// streamPage is how many entries the stream reads at a time.
const streamPage = 500

// StreamActivity sends Activity as Server-Sent Events, each with its sequence number as the event
// id, from after Last-Event-ID (or `after`), or from now when neither is sent. It wakes when a write to the Organisation commits,
// sends a comment every keep-alive interval while idle, and ends when the client goes away (ADR
// 0006) — or when its token is revoked or its Session closed: before sending anything it checks
// the caller again, after reading, so nothing committed after a revocation goes out.
func (s *Server) StreamActivity(w http.ResponseWriter, r *http.Request, params gen.StreamActivityParams) {
	c := caller(r)
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, gen.ErrorCodeInternal, "this connection cannot stream")
		return
	}
	if !s.streams.enter(w, c) {
		return
	}
	defer s.streams.leave(c)
	var after int64
	switch {
	case params.LastEventID != nil:
		after = *params.LastEventID
	case params.After != nil:
		after = *params.After
	default:
		latest, err := s.core.LatestSeq(r.Context(), c)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		after = latest
	}
	if after < 0 {
		invalid(w, "Last-Event-ID and after are not negative")
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ctx := r.Context()
	keepAlive := time.NewTicker(s.keepAlive)
	defer keepAlive.Stop()
	for {
		woken := s.wake.Wait(c.OrgID)
		page, err := s.core.ListActivity(ctx, c, core.ActivityQuery{After: after, Limit: streamPage})
		if err != nil {
			if ctx.Err() == nil {
				s.log.Error("activity stream", "err", err)
			}
			return
		}
		// Checked only when there is something to send, so a wake with nothing new costs one read;
		// the keep-alive tick checks an idle stream.
		if len(page.Items) > 0 && !s.stillValid(ctx, c) {
			return
		}
		for _, a := range page.Items {
			data, err := json.Marshal(activityOut(a))
			if err != nil {
				s.log.Error("activity stream", "err", err)
				return
			}
			if _, err := fmt.Fprintf(w, "id: %d\nevent: activity\ndata: %s\n\n", a.Seq, data); err != nil {
				return
			}
		}
		after = page.LastSeq
		if len(page.Items) > 0 {
			flusher.Flush()
			keepAlive.Reset(s.keepAlive)
		}
		if len(page.Items) == streamPage {
			continue
		}
		select {
		case <-woken:
		case <-keepAlive.C:
			if !s.stillValid(ctx, c) {
				return
			}
			if _, err := fmt.Fprint(w, ": keep-alive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-ctx.Done():
			return
		}
	}
}

// stillValid reports whether a long request's caller may still act: its Session open, its token
// unrevoked.
func (s *Server) stillValid(ctx context.Context, c *auth.Caller) bool {
	ok, err := s.core.CallerValid(ctx, c)
	if err != nil && ctx.Err() == nil {
		s.log.Error("activity stream: check the caller", "err", err)
	}
	return err == nil && ok
}
