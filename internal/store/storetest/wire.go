package storetest

import (
	"context"
	"net"
	"sync"
	"sync/atomic"

	"github.com/jackc/pgx/v5"
	"github.com/tuongaz/darkory/internal/store"
)

// Wire counts the round trips a Postgres Store makes: each time the client reads after writing,
// it has waited for the server once. Round trips made while a pgx batch is in flight are also
// counted apart, since a hot-path write is one batch holding the whole transaction (plan
// invariant 4).
type Wire struct {
	total     atomic.Int64
	inBatch   atomic.Int64
	batches   atomic.Int64
	batchRTs  atomic.Int64
	queries   atomic.Int64
	sqlInLast sync.Mutex
	lastBatch []string
}

// Option makes a Store report to w. Open the Store with store.WithMaxConns(1) as well, so a
// warm-up and the measured call use the same connection and its statement cache.
func (w *Wire) Option() store.Option {
	return store.WithPostgresConfig(func(cfg *pgx.ConnConfig) {
		dial := cfg.DialFunc
		cfg.DialFunc = func(ctx context.Context, network, addr string) (net.Conn, error) {
			c, err := dial(ctx, network, addr)
			if err != nil {
				return nil, err
			}
			return &countingConn{Conn: c, w: w}, nil
		}
		cfg.Tracer = w
	})
}

// Snapshot is what a Wire has counted.
type Snapshot struct {
	// RoundTrips is every round trip.
	RoundTrips int64
	// Batches is how many pgx batches were sent, and BatchRoundTrips the round trips made while
	// one was in flight.
	Batches, BatchRoundTrips int64
	// Queries counts statements sent outside batches.
	Queries int64
}

// Snapshot returns the counts so far.
func (w *Wire) Snapshot() Snapshot {
	return Snapshot{
		RoundTrips:      w.total.Load(),
		Batches:         w.batches.Load(),
		BatchRoundTrips: w.batchRTs.Load(),
		Queries:         w.queries.Load(),
	}
}

// Since returns the counts made after s was taken.
func (w *Wire) Since(s Snapshot) Snapshot {
	n := w.Snapshot()
	return Snapshot{
		RoundTrips:      n.RoundTrips - s.RoundTrips,
		Batches:         n.Batches - s.Batches,
		BatchRoundTrips: n.BatchRoundTrips - s.BatchRoundTrips,
		Queries:         n.Queries - s.Queries,
	}
}

// LastBatch returns the statements of the last batch sent.
func (w *Wire) LastBatch() []string {
	w.sqlInLast.Lock()
	defer w.sqlInLast.Unlock()
	return append([]string(nil), w.lastBatch...)
}

func (w *Wire) roundTrip() {
	w.total.Add(1)
	if w.inBatch.Load() > 0 {
		w.batchRTs.Add(1)
	}
}

// TraceQueryStart implements pgx.QueryTracer.
func (w *Wire) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	w.queries.Add(1)
	return ctx
}

// TraceQueryEnd implements pgx.QueryTracer.
func (w *Wire) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

// TraceBatchStart implements pgx.BatchTracer.
func (w *Wire) TraceBatchStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceBatchStartData) context.Context {
	w.batches.Add(1)
	w.inBatch.Add(1)
	sqls := make([]string, 0, data.Batch.Len())
	for _, q := range data.Batch.QueuedQueries {
		sqls = append(sqls, q.SQL)
	}
	w.sqlInLast.Lock()
	w.lastBatch = sqls
	w.sqlInLast.Unlock()
	return ctx
}

// TraceBatchQuery implements pgx.BatchTracer.
func (w *Wire) TraceBatchQuery(context.Context, *pgx.Conn, pgx.TraceBatchQueryData) {}

// TraceBatchEnd implements pgx.BatchTracer.
func (w *Wire) TraceBatchEnd(context.Context, *pgx.Conn, pgx.TraceBatchEndData) {
	w.inBatch.Add(-1)
}

type countingConn struct {
	net.Conn
	w     *Wire
	mu    sync.Mutex
	wrote bool
}

func (c *countingConn) Write(p []byte) (int, error) {
	c.mu.Lock()
	c.wrote = true
	c.mu.Unlock()
	return c.Conn.Write(p)
}

func (c *countingConn) Read(p []byte) (int, error) {
	c.mu.Lock()
	if c.wrote {
		c.wrote = false
		c.w.roundTrip()
	}
	c.mu.Unlock()
	return c.Conn.Read(p)
}
