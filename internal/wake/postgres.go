package wake

import (
	"context"
	crand "crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
)

// Channel is the Postgres notification channel the server processes of one database share. A
// notification's payload is the Organisation's id, a space, and the id of the process that sent
// it, so a process skips its own: it has already woken its waiters.
const Channel = "darkory_wake"

// ApplicationName names the LISTEN connection in pg_stat_activity.
const ApplicationName = "darkory-wake"

// probeOrg is the Organisation id of the notification a process sends itself at start, to check
// that its LISTEN connection receives what the others send.
const probeOrg = "-"

var (
	// probeWait is how long a process waits for its own notification before warning that its
	// LISTEN connection does not receive.
	probeWait = 5 * time.Second
	// pingEvery is how long the LISTEN connection waits for a notification before checking it is
	// still alive: a connection lost to a network partition reports nothing by itself.
	pingEvery = 30 * time.Second
	// retryAfter is how long a NOTIFY that failed waits before it is sent again.
	retryAfter = time.Second
	// Reconnecting waits between minBackoff and maxBackoff, doubling.
	minBackoff = 100 * time.Millisecond
	maxBackoff = 5 * time.Second
)

// Querier runs a statement outside any transaction; *store.Store is one.
type Querier interface {
	Query(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// Postgres links a Notifier to the other server processes on one Postgres database.
type Postgres struct {
	n   *Notifier
	id  string
	log *slog.Logger
	cfg *pgx.ConnConfig
	pub *publisher
	// pingEvery and probeWait are the package's, read once at start.
	pingEvery, probeWait time.Duration
	cancel               context.CancelFunc
	wg                   sync.WaitGroup
	// pid is the LISTEN connection's backend process id, 0 while disconnected.
	pid       atomic.Uint32
	probeOnce sync.Once
	probed    chan struct{}
}

// ListenPostgres links n to every other server process on the same Postgres database (ADR 0006).
// Each Signal is also sent with NOTIFY through db, as its own statement after the write has
// committed, so the commit of a write never waits on the lock NOTIFY takes; Signals arriving
// while one is being sent go together in the next. A dedicated connection to listenDSN LISTENs
// and wakes this process's waiters. When that connection is lost it reconnects with backoff, then
// wakes every waiter here, since a notification may have been missed meanwhile; waiters re-read,
// so a missed notification strands nobody.
//
// listenDSN must reach Postgres directly or through session pooling: LISTEN through a
// transaction-pooling PgBouncer is accepted and never delivers. At start the process notifies
// itself and logs a warning when that does not arrive.
//
// ListenPostgres returns once LISTEN is in place; Close stops it.
func ListenPostgres(ctx context.Context, n *Notifier, db Querier, listenDSN string, log *slog.Logger) (*Postgres, error) {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	cfg, err := pgx.ParseConfig(listenDSN)
	if err != nil {
		return nil, fmt.Errorf("wake: the LISTEN connection's URL: %w", redact(listenDSN, err))
	}
	cfg.RuntimeParams["application_name"] = ApplicationName
	var b [8]byte
	_, _ = crand.Read(b[:])
	p := &Postgres{n: n, id: hex.EncodeToString(b[:]), log: log, cfg: cfg, pingEvery: pingEvery, probeWait: probeWait, probed: make(chan struct{})}
	conn, err := p.connect(ctx)
	if err != nil {
		return nil, err
	}
	p.pub = newPublisher(notifyThrough(db), p.id, log)

	runCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	p.cancel = cancel
	p.wg.Add(2)
	go func() { defer p.wg.Done(); p.pub.run(runCtx) }()
	go func() { defer p.wg.Done(); p.listen(runCtx, conn) }()
	n.setPublish(p.pub.publish)

	p.pub.publish(probeOrg)
	go func() {
		select {
		case <-p.probed:
		case <-time.After(p.probeWait):
			log.Warn("this server's LISTEN connection has not received its own notification; other server processes' "+
				"writes may wake its waiters late. Point DARKORY_DB_LISTEN at the same database as DARKORY_DB, directly "+
				"or through session pooling, not a transaction-pooling PgBouncer", "waited", p.probeWait)
		case <-runCtx.Done():
		}
	}()
	return p, nil
}

// Close stops publishing and listening. The Notifier goes back to waking this process only.
func (p *Postgres) Close() {
	p.n.setPublish(nil)
	p.cancel()
	p.wg.Wait()
}

// connect opens the LISTEN connection and starts listening.
func (p *Postgres) connect(ctx context.Context) (*pgx.Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	conn, err := pgx.ConnectConfig(ctx, p.cfg)
	if err != nil {
		return nil, fmt.Errorf("wake: connect for LISTEN: %w", err)
	}
	if _, err := conn.Exec(ctx, "LISTEN "+Channel); err != nil {
		conn.Close(context.Background())
		return nil, fmt.Errorf("wake: LISTEN: %w", err)
	}
	p.pid.Store(conn.PgConn().PID())
	return conn, nil
}

// listen receives notifications on conn, and on a new connection whenever it is lost, until ctx
// ends.
func (p *Postgres) listen(ctx context.Context, conn *pgx.Conn) {
	backoff := minBackoff
	for {
		err := p.receive(ctx, conn)
		p.pid.Store(0)
		conn.Close(context.Background())
		if ctx.Err() != nil {
			return
		}
		p.log.Warn("lost the LISTEN connection for wakes from other server processes; reconnecting", "err", err)
		for {
			// Jittered, so the processes of a restarted database do not reconnect in step.
			wait := backoff/2 + rand.N(backoff/2+1)
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
			backoff = min(2*backoff, maxBackoff)
			if conn, err = p.connect(ctx); err == nil {
				break
			}
			if ctx.Err() != nil {
				return
			}
			p.log.Warn("reconnecting the LISTEN connection", "err", err, "retry_in", backoff)
		}
		backoff = minBackoff
		p.log.Info("reconnected the LISTEN connection for wakes from other server processes")
		// LISTEN is back in place first, so whatever commits from here on is notified; what
		// committed before it may have been missed, so everyone here re-reads.
		p.n.wakeAll()
	}
}

// receive delivers notifications from conn until it fails or ctx ends. After p.pingEvery without
// one it checks the connection.
func (p *Postgres) receive(ctx context.Context, conn *pgx.Conn) error {
	for {
		waitCtx, cancel := context.WithTimeout(ctx, p.pingEvery)
		nt, err := conn.WaitForNotification(waitCtx)
		cancel()
		switch {
		case err == nil:
			p.deliver(nt.Payload)
			continue
		case ctx.Err() != nil:
			return ctx.Err()
		case !errors.Is(err, context.DeadlineExceeded) || conn.IsClosed():
			return err
		}
		// The wait timed out, which leaves the connection usable; check it answers.
		pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err = conn.Ping(pingCtx)
		cancel()
		if err != nil {
			return fmt.Errorf("ping: %w", err)
		}
	}
}

func (p *Postgres) deliver(payload string) {
	org, from, _ := strings.Cut(payload, " ")
	switch {
	case from == p.id:
		if org == probeOrg {
			p.probeOnce.Do(func() { close(p.probed) })
		}
	case org != "" && org != probeOrg:
		p.n.wake(org)
	}
}

// publisher sends Signals as notifications. Signals for any Organisations that arrive while a
// send is under way are gathered into the next one, so a burst of writes makes few NOTIFYs.
type publisher struct {
	send       func(ctx context.Context, payloads []string) error
	from       string
	log        *slog.Logger
	retryAfter time.Duration

	mu      sync.Mutex
	pending map[string]struct{}
	kick    chan struct{}
}

func newPublisher(send func(ctx context.Context, payloads []string) error, from string, log *slog.Logger) *publisher {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &publisher{send: send, from: from, log: log, retryAfter: retryAfter, pending: map[string]struct{}{}, kick: make(chan struct{}, 1)}
}

// publish asks for orgID to be notified; it never blocks.
func (p *publisher) publish(orgID string) {
	p.mu.Lock()
	p.pending[orgID] = struct{}{}
	p.mu.Unlock()
	select {
	case p.kick <- struct{}{}:
	default:
	}
}

// run sends what is pending, one statement at a time, until ctx ends. A send that fails is
// retried after retryAfter together with whatever arrived meanwhile.
func (p *publisher) run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-p.kick:
		}
		p.mu.Lock()
		orgs := make([]string, 0, len(p.pending))
		for org := range p.pending {
			orgs = append(orgs, org)
		}
		clear(p.pending)
		p.mu.Unlock()
		if len(orgs) == 0 {
			continue
		}
		payloads := make([]string, len(orgs))
		for i, org := range orgs {
			payloads[i] = org + " " + p.from
		}
		sendCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := p.send(sendCtx, payloads)
		cancel()
		if err == nil {
			continue
		}
		if ctx.Err() != nil {
			return
		}
		p.log.Warn("could not notify other server processes of a write; retrying", "err", err, "organisations", len(orgs))
		select {
		case <-ctx.Done():
			return
		case <-time.After(p.retryAfter):
		}
		for _, org := range orgs {
			p.publish(org)
		}
	}
}

// notifyThrough sends payloads on Channel in one statement through db.
func notifyThrough(db Querier) func(ctx context.Context, payloads []string) error {
	return func(ctx context.Context, payloads []string) error {
		rows, err := db.Query(ctx, `SELECT pg_notify($1, p) FROM unnest($2::text[]) AS p`, Channel, payloads)
		if err != nil {
			return err
		}
		for rows.Next() {
		}
		rows.Close()
		return rows.Err()
	}
}

// redact keeps a password out of an error that may quote the URL.
func redact(dsn string, err error) error {
	_, rest, ok := strings.Cut(dsn, "://")
	if !ok {
		return err
	}
	userinfo, _, ok := strings.Cut(rest, "@")
	if !ok {
		return err
	}
	if _, pw, ok := strings.Cut(userinfo, ":"); ok && pw != "" {
		return errors.New(strings.ReplaceAll(err.Error(), pw, "xxxxx"))
	}
	return err
}
