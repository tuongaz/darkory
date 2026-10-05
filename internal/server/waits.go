package server

import (
	"fmt"
	"net/http"
	"sync"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/server/gen"
)

// DefaultMaxWaiting is how many Activity streams, and separately how many waiting `next` calls, a
// Member may have open on one server process at once, unless Options.MaxWaiting says otherwise.
const DefaultMaxWaiting = 16

// waiting counts one kind of long request — Activity streams, or `next` calls — that each Member
// has open on this process. Each holds a connection and reads again on every write to the
// Organisation, so one token opening hundreds would hold the server's connections and multiply
// its reads (security review L4).
type waiting struct {
	what string
	max  int
	mu   sync.Mutex
	open map[string]int
}

func newWaiting(what string, max int) *waiting {
	return &waiting{what: what, max: max, open: map[string]int{}}
}

// enter counts one more request of c's Member, or answers 429 too_many_requests and reports
// false when they already have the most allowed. The caller calls leave when it ends.
func (l *waiting) enter(w http.ResponseWriter, c *auth.Caller) bool {
	key := c.OrgID + "/" + c.MemberID
	l.mu.Lock()
	n := l.open[key]
	if n >= l.max {
		l.mu.Unlock()
		writeError(w, http.StatusTooManyRequests, gen.ErrorCodeTooManyRequests,
			fmt.Sprintf("this Member already has %d %s open on this server; end one first", n, l.what))
		return false
	}
	l.open[key] = n + 1
	l.mu.Unlock()
	return true
}

func (l *waiting) leave(c *auth.Caller) {
	key := c.OrgID + "/" + c.MemberID
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.open[key] <= 1 {
		delete(l.open, key)
		return
	}
	l.open[key]--
}
