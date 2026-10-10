package runner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/cli/remote"
	"github.com/tuongaz/darkory/internal/runnerapi"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// recordingGitHub stands in for gh: it lists the pull requests a test sets, newest first, records
// the ones the runner opens and merges, and refuses a merge with refuse when it is set.
type recordingGitHub struct {
	mu      sync.Mutex
	prs     []PullRequest
	created []string
	merges  []int64
	// heads are the commits each merge was asked for, in turn.
	heads  []string
	refuse string
}

func (g *recordingGitHub) CreatePR(_ context.Context, repo, base, head, title, _ string) (string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.created = append(g.created, base+" <- "+head+": "+title)
	return "https://github.com/acme/web/pull/9", nil
}

func (g *recordingGitHub) PullRequests(context.Context, string) ([]PullRequest, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := slices.Clone(g.prs)
	slices.Reverse(out)
	return out, nil
}

func (g *recordingGitHub) PullRequestsForBranch(ctx context.Context, repo, branch string) ([]PullRequest, error) {
	all, _ := g.PullRequests(ctx, repo)
	return slices.DeleteFunc(all, func(pr PullRequest) bool { return pr.HeadRefName != branch }), nil
}

func (g *recordingGitHub) PullRequest(_ context.Context, _ string, n int64) (PullRequest, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, pr := range g.prs {
		if pr.Number == n {
			return pr, nil
		}
	}
	return PullRequest{}, fmt.Errorf("gh pr view: exit status 1: GraphQL: Could not resolve to a PullRequest with the number of %d.", n)
}

func (g *recordingGitHub) MergePR(_ context.Context, _ string, n int64, head string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.heads = append(g.heads, head)
	if g.refuse != "" {
		return errors.New(g.refuse)
	}
	g.merges = append(g.merges, n)
	for i := range g.prs {
		if g.prs[i].Number == n {
			g.prs[i].State = PRMerged
		}
	}
	return nil
}

// open adds pr to GitHub, open; set replaces the one of its number, or adds it.
func (g *recordingGitHub) open(pr PullRequest) {
	pr.State = PROpen
	g.set(pr)
}

// merge adds pr to GitHub merged, or merges the one of its number.
func (g *recordingGitHub) merge(pr PullRequest) {
	pr.State = PRMerged
	g.set(pr)
}

func (g *recordingGitHub) set(pr PullRequest) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for i := range g.prs {
		if g.prs[i].Number == pr.Number {
			g.prs[i] = pr
			return
		}
	}
	g.prs = append(g.prs, pr)
}

func (g *recordingGitHub) opened() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return slices.Clone(g.created)
}

// In a pull_request Workspace the runner merges nothing itself (D14): the builder's advance leaves
// the Subtask waiting at Review; the pull request whose head is its branch merging on GitHub
// advances it into Done, claimed as an agent that may review, with a Note, and the merge's Note
// names that pull request; the Parent's own pull request is no review; and the Parent's Complete
// opens its branch's pull request into main instead of merging.
func TestRunnerPullRequestMode(t *testing.T) {
	f := newFixture(t, storetest.Open(t, store.SQLite))
	f.ok("ada", "workspace", "set", "web", "--mode", "pull_request")
	f.agent("builder", "advance", "engineer")
	f.agent("reviewer", "advance", "review")
	f.ok("ada", "agent", "set", "reviewer", "--paused") // no session reviews it: GitHub does
	gh := &recordingGitHub{}
	// The builder opens its pull request in its Shift, as an agent does.
	gh.open(PullRequest{Number: 7, Title: "WEB-2: Cart page", HeadRefName: "web-2-cart-page", BaseRefName: "web-1", URL: "https://github.com/acme/web/pull/7"})
	f.gh = gh
	f.run("builder", "reviewer")
	f.ok("ada", "file", "--project", "WEB", "--title", "Checkout")
	f.ok("ada", "file", "--parent", "WEB-1", "--title", "Cart page")
	eventually(t, 20*time.Second, "WEB-2 advanced to Review", func() bool {
		d := f.task("WEB-2")
		return d.Step != nil && d.Step.Name == "Review" && d.Task.Claim == nil
	})
	eventually(t, 10*time.Second, "WEB-2's pull request open on the Task", func() bool {
		pr := f.task("WEB-2").Task.PullRequest
		return pr != nil && pr.Number == 7 && pr.State == client.PullRequestOpen
	})
	eventually(t, 10*time.Second, "the builder's Shift read it at its end", func() bool {
		return strings.Contains(f.log.String(), `msg="read the Task's pull request" component=runner agent=builder task=WEB-2 workspace=web pr=7 state=open`)
	})
	if !branchExists(t.Context(), f.repo, "web-1") {
		t.Fatal("no Parent's branch for the pull request's base")
	}
	// A pull request with no Task's key, the Parent's own, one with the key in its title only, and
	// one of the Task's branch into another base are not reviews: one landing rule.
	gh.merge(PullRequest{Number: 5, Title: "Bump the linter", HeadRefName: "chore/lint", URL: "https://github.com/acme/web/pull/5"})
	gh.merge(PullRequest{Number: 6, Title: "WEB-1: Checkout", HeadRefName: "web-1", BaseRefName: "main", URL: "https://github.com/acme/web/pull/6"})
	gh.merge(PullRequest{Number: 3, Title: "WEB-2: bump", HeadRefName: "chore/bump", BaseRefName: "web-1", URL: "https://github.com/acme/web/pull/3"})
	gh.merge(PullRequest{Number: 4, Title: "WEB-2: Cart page", HeadRefName: "web-2-cart-page", BaseRefName: "develop", URL: "https://github.com/acme/web/pull/4"})
	time.Sleep(5 * f.timings.Poll)
	if d := f.task("WEB-2"); d.Task.State != client.TaskStateOpen || d.Step == nil || d.Step.Name != "Review" {
		t.Fatalf("a pull request that is not WEB-2's landing completed its review: %s at %v", d.Task.State, stepName(&d))
	}
	gh.merge(PullRequest{Number: 7, Title: "WEB-2: Cart page", HeadRefName: "web-2-cart-page", BaseRefName: "web-1", URL: "https://github.com/acme/web/pull/7"})
	eventually(t, 20*time.Second, "WEB-2's review completed by its pull request", func() bool { return f.task("WEB-2").Task.State == client.TaskStateDone })
	// The merged write goes through the server's check on GitHub, which asks this Runner.
	eventually(t, 10*time.Second, "WEB-2's pull request merged on the Task", func() bool {
		pr := f.task("WEB-2").Task.PullRequest
		return pr != nil && pr.Number == 7 && pr.State == client.PullRequestMerged
	})
	if f.task("WEB-1").Task.PullRequest != nil {
		t.Fatal("the Parent's own pull request was written on it as a Task's")
	}
	d := f.task("WEB-2")
	last := d.Claims[len(d.Claims)-1]
	if last.HolderID != f.ids["reviewer"] || !strings.Contains(notesOf(d), "Pull request #7 (https://github.com/acme/web/pull/7) was merged on GitHub") {
		t.Fatalf("WEB-2's last Claim %+v, Notes:\n%s", last, notesOf(d))
	}
	eventually(t, 10*time.Second, "WEB-2's merge Note", func() bool {
		return strings.Contains(notesOf(f.task("WEB-2")), "web: web-2-cart-page was merged into web-1 through pull request #7 (https://github.com/acme/web/pull/7).")
	})
	if _, err := runGit(t.Context(), f.repo, "merge-base", "--is-ancestor", "web-2-cart-page", "web-1"); err == nil {
		t.Fatal("the runner merged a pull_request Workspace's branch itself")
	}

	f.ok("ada", "complete", "WEB-1")
	eventually(t, 10*time.Second, "the Parent's pull request opened", func() bool { return len(gh.opened()) == 1 })
	if got := gh.opened()[0]; got != "main <- web-1: WEB-1: Checkout" {
		t.Fatalf("opened %q", got)
	}
	eventually(t, 10*time.Second, "the Parent's Note", func() bool {
		return strings.Contains(notesOf(f.task("WEB-1")), "web: opened https://github.com/acme/web/pull/9, the pull request of web-1 into main.")
	})
}

// A done Task whose branch has nothing ahead of its base lands nothing: the merge Note says so
// instead of promising a pull request; a branch with commits still lands through its pull request.
func TestPullRequestLineSaysWhenNothingLanded(t *testing.T) {
	repo := gitRepo(t)
	mustGit(t, repo, "branch", "dark-3-triage")
	mustGit(t, repo, "branch", "dark-3-build")
	mustGit(t, repo, "checkout", "-q", "dark-3-build")
	commitFile(t, repo, "b.txt", "x\n", "work")
	mustGit(t, repo, "checkout", "-q", "main")
	r := &Runner{gh: &recordingGitHub{}}
	ws := Workspace{Name: "darkory", Path: repo, Mode: ModePullRequest}

	got := r.pullRequestLine(t.Context(), ws, "dark-3-triage", "main", "")
	if !strings.Contains(got, "has no commits ahead of main, so nothing landed") || strings.Contains(got, "lands in main") {
		t.Errorf("a branch with nothing ahead: %q", got)
	}
	got = r.pullRequestLine(t.Context(), ws, "dark-3-build", "main", "")
	if !strings.Contains(got, "lands in main through its pull request") {
		t.Errorf("a branch with commits: %q", got)
	}
}

// taskRecord stands in for the Install as far as reading pull requests and writing them goes:
// Tasks by id or key with their Workspaces, and the pull requests written, by whom. setHook, when
// set, runs inside every SetPullRequest before it returns, as the server's check of a merged write
// calls back into the Runner. Anything else panics on the nil Record it embeds.
type taskRecord struct {
	Record
	name string
	// projects are the Projects its agent is a Member of.
	projects []client.Project
	tasks    []*client.TaskDetail
	wss      map[string][]Workspace // by Task id

	mu      sync.Mutex
	reads   map[string]int // Task reads, by the ref asked
	writes  []string
	refuse  map[string]client.ErrorCode // by Task key: the code a write is refused with
	setHook func(task string, pr client.PullRequest) error
}

func (f *taskRecord) find(ref string) *client.TaskDetail {
	for _, d := range f.tasks {
		if d.Task.ID == ref || d.Task.Key == ref {
			return d
		}
	}
	return nil
}

func (f *taskRecord) Task(_ context.Context, ref string) (*client.TaskDetail, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.reads == nil {
		f.reads = map[string]int{}
	}
	f.reads[ref]++
	if d := f.find(ref); d != nil {
		c := *d
		return &c, nil
	}
	return nil, &remote.Error{Status: 404, Code: client.ErrorCodeNotFound, Message: "no Task " + ref}
}

func (f *taskRecord) Workspaces(_ context.Context, d *client.TaskDetail) ([]Workspace, error) {
	return f.wss[d.Task.ID], nil
}

func (f *taskRecord) SetPullRequest(_ context.Context, task string, pr client.PullRequest) error {
	if f.setHook != nil {
		if err := f.setHook(task, pr); err != nil {
			return err
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if code, ok := f.refuse[task]; ok {
		return &remote.Error{Status: 409, Code: code, Message: "refused"}
	}
	d := f.find(task)
	if d == nil {
		return &remote.Error{Status: 404, Code: client.ErrorCodeNotFound, Message: "no Task " + task}
	}
	d.Task.PullRequest = &pr
	f.writes = append(f.writes, fmt.Sprintf("%s %s #%d %s", f.name, task, pr.Number, pr.State))
	return nil
}

func (f *taskRecord) written() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.writes)
}

// byRepo is GitHub with a repository each.
type byRepo map[string]*recordingGitHub

func (g byRepo) CreatePR(ctx context.Context, repo, base, head, title, body string) (string, error) {
	return g[repo].CreatePR(ctx, repo, base, head, title, body)
}
func (g byRepo) PullRequests(ctx context.Context, repo string) ([]PullRequest, error) {
	return g[repo].PullRequests(ctx, repo)
}
func (g byRepo) PullRequestsForBranch(ctx context.Context, repo, branch string) ([]PullRequest, error) {
	return g[repo].PullRequestsForBranch(ctx, repo, branch)
}
func (g byRepo) PullRequest(ctx context.Context, repo string, n int64) (PullRequest, error) {
	return g[repo].PullRequest(ctx, repo, n)
}
func (g byRepo) MergePR(ctx context.Context, repo string, n int64, head string) error {
	return g[repo].MergePR(ctx, repo, n, head)
}

// mergeRunner is a Runner reading rec, started, with GitHub gh.
func mergeRunner(t *testing.T, rec Record, gh GitHub) *Runner {
	t.Helper()
	r, err := New(Config{Data: t.TempDir(), Tmux: "off", Darkory: "darkory", GitHub: gh})
	if err != nil {
		t.Fatal(err)
	}
	r.reader = rec
	close(r.ready)
	return r
}

// DARK-3 "Fix the cart" in the Workspace web (pull_request mode, into main), and DARK-5 a Subtask
// of DARK-4, whose branch is dark-4.
func mergeFixture() *taskRecord {
	web := Workspace{ID: "w-web", Name: "web", Path: "/src/web", Mode: ModePullRequest, DefaultBranch: "main"}
	return &taskRecord{name: "reader",
		tasks: []*client.TaskDetail{
			{Task: client.Task{ID: "t-3", Key: "DARK-3", Title: "Fix the cart", State: client.TaskStateDone, ProjectID: "p-dark"}},
			{Task: client.Task{ID: "t-5", Key: "DARK-5", Title: "Totals", State: client.TaskStateDone, ProjectID: "p-dark"},
				Parent: &client.TaskBrief{ID: "t-4", Key: "DARK-4", Title: "Checkout"}},
		},
		wss: map[string][]Workspace{"t-3": {web}, "t-5": {web}}}
}

// Merge merges the Task's pull request when its head is the Task's branch, by its key's prefix
// whatever the title says now, and its base the branch's own: the default branch for a Task
// standing alone, the Parent's branch for a Subtask. It merges the commit it checked. It refuses a
// foreign head or base in words the Owner reads, finds no pull request when GitHub has it closed,
// merged, from a fork or not at all, and passes GitHub's refusal on as GitHub said it. It writes
// nothing on the Task.
func TestRunnerMerge(t *testing.T) {
	for _, tc := range []struct {
		name   string
		task   string
		pr     PullRequest
		refuse string
		want   string // the error, "" for a merge
		noPR   bool
		noOid  bool // GitHub gives no head commit
	}{
		{name: "head and base match", task: "t-3", pr: PullRequest{HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", State: PROpen}},
		{name: "a renamed Task", task: "t-3", pr: PullRequest{HeadRefName: "dark-3-old-title", BaseRefName: "main", State: PROpen}},
		{name: "a foreign head", task: "t-3", pr: PullRequest{HeadRefName: "dark-9-other", BaseRefName: "main", State: PROpen},
			want: "pull request #7's branch dark-9-other is not DARK-3's"},
		{name: "a longer key", task: "t-3", pr: PullRequest{HeadRefName: "dark-30-cart", BaseRefName: "main", State: PROpen},
			want: "pull request #7's branch dark-30-cart is not DARK-3's"},
		{name: "a slash after the key", task: "t-3", pr: PullRequest{HeadRefName: "dark-3/cart", BaseRefName: "main", State: PROpen},
			want: "pull request #7's branch dark-3/cart is not DARK-3's"},
		{name: "a foreign base", task: "t-3", pr: PullRequest{HeadRefName: "dark-3-fix-the-cart", BaseRefName: "develop", State: PROpen},
			want: "pull request #7 is into develop, not main"},
		{name: "a Subtask into its Parent's branch", task: "t-5", pr: PullRequest{HeadRefName: "dark-5-totals", BaseRefName: "dark-4", State: PROpen}},
		{name: "a Subtask into main", task: "t-5", pr: PullRequest{HeadRefName: "dark-5-totals", BaseRefName: "main", State: PROpen},
			want: "pull request #7 is into main, not dark-4"},
		{name: "closed", task: "t-3", pr: PullRequest{HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", State: PRClosed}, noPR: true},
		{name: "merged already", task: "t-3", pr: PullRequest{HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", State: PRMerged}, noPR: true},
		{name: "from a fork", task: "t-3", pr: PullRequest{HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", State: PROpen,
			IsCrossRepository: true}, noPR: true},
		{name: "no head commit", task: "t-3", pr: PullRequest{HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", State: PROpen}, noOid: true,
			want: "GitHub did not say which commit #7 is at"},
		{name: "GitHub refuses", task: "t-3", pr: PullRequest{HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", State: PROpen},
			refuse: "Pull request acme/web#7 is not mergeable: the merge commit cannot be cleanly created.",
			want:   "Pull request acme/web#7 is not mergeable: the merge commit cannot be cleanly created."},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gh := &recordingGitHub{refuse: tc.refuse}
			tc.pr.Number, tc.pr.URL, tc.pr.HeadRefOid = 7, "https://github.com/acme/web/pull/7", "c0ffee"
			if tc.noOid {
				tc.pr.HeadRefOid = ""
			}
			gh.set(tc.pr)
			rec := mergeFixture()
			r := mergeRunner(t, rec, gh)
			err := r.Merge(t.Context(), tc.task, 7)
			switch {
			case tc.noPR:
				if !errors.Is(err, runnerapi.ErrNoPullRequest) {
					t.Fatalf("Merge: %v, want ErrNoPullRequest", err)
				}
			case tc.want == "":
				if err != nil {
					t.Fatalf("Merge: %v", err)
				}
				if !slices.Equal(gh.merges, []int64{7}) || !slices.Equal(gh.heads, []string{"c0ffee"}) {
					t.Fatalf("merged %v at %v", gh.merges, gh.heads)
				}
			default:
				if err == nil || err.Error() != tc.want {
					t.Fatalf("Merge: %v, want %q", err, tc.want)
				}
			}
			if tc.want != "" || tc.noPR {
				if len(gh.merges) != 0 {
					t.Fatalf("merged %v after refusing", gh.merges)
				}
			}
			if w := rec.written(); len(w) != 0 {
				t.Fatalf("Merge wrote %v", w)
			}
		})
	}

	// Two Workspaces each with a #7 of the Task's branch: the one the record's address names.
	t.Run("the record's address", func(t *testing.T) {
		rec := mergeFixture()
		api := Workspace{ID: "w-api", Name: "api", Path: "/src/api", Mode: ModePullRequest, DefaultBranch: "main"}
		rec.wss["t-3"] = append([]Workspace{api}, rec.wss["t-3"]...)
		rec.tasks[0].Task.PullRequest = &client.PullRequest{Number: 7, URL: "https://github.com/acme/web/pull/7", State: client.PullRequestOpen}
		gh := byRepo{"/src/api": {}, "/src/web": {}}
		gh["/src/api"].open(PullRequest{Number: 7, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", URL: "https://github.com/acme/api/pull/7", HeadRefOid: "a"})
		gh["/src/web"].open(PullRequest{Number: 7, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", URL: "https://github.com/acme/web/pull/7", HeadRefOid: "w"})
		r := mergeRunner(t, rec, gh)
		if err := r.Merge(t.Context(), "t-3", 7); err != nil {
			t.Fatal(err)
		}
		if len(gh["/src/api"].merges) != 0 || !slices.Equal(gh["/src/web"].merges, []int64{7}) {
			t.Fatalf("merged api %v, web %v", gh["/src/api"].merges, gh["/src/web"].merges)
		}
	})

	// A number no Workspace of the Task has: no pull request.
	r := mergeRunner(t, mergeFixture(), &recordingGitHub{})
	if err := r.Merge(t.Context(), "t-3", 8); !errors.Is(err, runnerapi.ErrNoPullRequest) {
		t.Fatalf("Merge of a missing pull request: %v", err)
	}
}

// PullRequest reads the Task's pull request in its Workspaces in pull_request mode, its state in
// lower case; of two Workspaces with the number, the one whose head is the Task's branch; never one
// from a fork.
func TestRunnerPullRequest(t *testing.T) {
	rec := mergeFixture()
	plain := Workspace{ID: "w-docs", Name: "docs", Path: "/src/docs", Mode: ModePlain}
	api := Workspace{ID: "w-api", Name: "api", Path: "/src/api", Mode: ModePullRequest, DefaultBranch: "main"}
	rec.wss["t-3"] = []Workspace{plain, api, rec.wss["t-3"][0]}
	gh := byRepo{"/src/docs": {}, "/src/api": {}, "/src/web": {}}
	gh["/src/docs"].set(PullRequest{Number: 7, HeadRefName: "dark-3-fix-the-cart", State: PROpen})
	gh["/src/api"].set(PullRequest{Number: 7, HeadRefName: "chore/bump", BaseRefName: "main", State: PROpen, URL: "https://github.com/acme/api/pull/7"})
	gh["/src/web"].set(PullRequest{Number: 7, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", State: PRMerged, URL: "https://github.com/acme/web/pull/7"})
	r := mergeRunner(t, rec, gh)
	ctx := t.Context()

	pr, err := r.PullRequest(ctx, "t-3", 7, "")
	if err != nil {
		t.Fatal(err)
	}
	want := runnerapi.PullRequest{Number: 7, URL: "https://github.com/acme/web/pull/7", State: "merged", Head: "dark-3-fix-the-cart", Base: "main",
		Landing: true}
	if pr != want {
		t.Fatalf("PullRequest: %+v, want %+v", pr, want)
	}
	for state, lower := range map[string]string{PROpen: "open", PRClosed: "closed"} {
		gh["/src/web"].set(PullRequest{Number: 7, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", State: state})
		if pr, err := r.PullRequest(ctx, "t-3", 7, ""); err != nil || pr.State != lower {
			t.Fatalf("PullRequest of a %s one: %+v, %v", state, pr, err)
		}
	}
	// A fork's #7 on a branch named for the Task is not the Task's: the other Workspace's is found.
	gh["/src/web"].set(PullRequest{Number: 7, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", State: PRMerged, IsCrossRepository: true})
	if pr, err := r.PullRequest(ctx, "t-3", 7, ""); err != nil || pr.Head != "chore/bump" {
		t.Fatalf("PullRequest with a fork's #7: %+v, %v", pr, err)
	}
	// Only another branch's #7 in a pull_request Workspace (the plain one's is not looked at): that
	// one, for the server to refuse by its head.
	gh["/src/web"].prs = nil
	if pr, err := r.PullRequest(ctx, "t-3", 7, ""); err != nil || pr.Head != "chore/bump" {
		t.Fatalf("PullRequest with only another branch's #7: %+v, %v", pr, err)
	}
	gh["/src/api"].set(PullRequest{Number: 7, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", State: PROpen, IsCrossRepository: true})
	if _, err := r.PullRequest(ctx, "t-3", 7, ""); !errors.Is(err, runnerapi.ErrNoPullRequest) {
		t.Fatalf("PullRequest with only a fork's #7: %v", err)
	}
	// Of two Workspaces with a #7 of the Task's branch, the address picks one; a landing says so.
	gh["/src/api"].set(PullRequest{Number: 7, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "develop", State: PROpen, URL: "https://github.com/acme/api/pull/7"})
	gh["/src/web"].set(PullRequest{Number: 7, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", State: PROpen, URL: "https://github.com/acme/web/pull/7"})
	for url, want := range map[string]runnerapi.PullRequest{
		"https://github.com/acme/api/pull/7": {Number: 7, URL: "https://github.com/acme/api/pull/7", State: "open", Head: "dark-3-fix-the-cart", Base: "develop"},
		"https://github.com/acme/web/pull/7": {Number: 7, URL: "https://github.com/acme/web/pull/7", State: "open", Head: "dark-3-fix-the-cart", Base: "main", Landing: true},
	} {
		if pr, err := r.PullRequest(ctx, "t-3", 7, url); err != nil || pr != want {
			t.Fatalf("PullRequest at %s: %+v, %v; want %+v", url, pr, err, want)
		}
	}
	if _, err := r.PullRequest(ctx, "t-3", 9, ""); !errors.Is(err, runnerapi.ErrNoPullRequest) {
		t.Fatalf("PullRequest of a missing one: %v", err)
	}
}

func (f *taskRecord) AllWorkspaces(context.Context) ([]Workspace, error) {
	seen := map[string]bool{}
	var out []Workspace
	for _, d := range f.tasks {
		for _, ws := range f.wss[d.Task.ID] {
			if !seen[ws.ID] {
				seen[ws.ID] = true
				out = append(out, ws)
			}
		}
	}
	return out, nil
}

// pollRunner is a Runner whose reader is rec, the agent reader, polling gh, with more agents, each
// of the Projects listed after it.
func pollRunner(t *testing.T, rec *taskRecord, gh GitHub, agents ...*taskRecord) *Runner {
	t.Helper()
	r := mergeRunner(t, rec, gh)
	r.log = slog.New(slog.NewTextHandler(&lockedBuffer{}, nil))
	r.agents = append(r.agents, &agent{r: r, rec: rec, me: client.Me{Member: client.Member{ID: "m-" + rec.name, Name: rec.name}}})
	for _, a := range agents {
		r.agents = append(r.agents, &agent{r: r, rec: a, me: client.Me{Member: client.Member{ID: "m-" + a.name, Name: a.name}, Projects: a.projects}})
	}
	return r
}

// The poller writes on a Task the pull request of its branch it reads on GitHub, open and then
// merged, within one Poll each, opened or merged by hand on a Done Task; a merged one over an
// open one, else the newest; once per state. A Parent's own branch, a branch with no Task's key, one with a slash after the
// key, a closed pull request, one into another base, one from a fork, and a key only in a title
// are not a Task's pull request.
func TestPollerRecordsPullRequests(t *testing.T) {
	rec := mergeFixture()
	gh := &recordingGitHub{}
	r := pollRunner(t, rec, gh)
	seen := map[string]bool{}
	url := func(n int64) string { return fmt.Sprintf("https://github.com/acme/web/pull/%d", n) }

	gh.open(PullRequest{Number: 6, HeadRefName: "dark-4", BaseRefName: "main", Title: "DARK-4: Checkout", URL: url(6)})
	gh.open(PullRequest{Number: 7, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", Title: "Fix the cart", URL: url(7)})
	gh.open(PullRequest{Number: 8, HeadRefName: "chore/bump", BaseRefName: "main", Title: "DARK-3: bump", URL: url(8)})
	gh.open(PullRequest{Number: 12, HeadRefName: "dark-3/feature", BaseRefName: "main", URL: url(12)})
	gh.set(PullRequest{Number: 9, HeadRefName: "dark-5-totals", BaseRefName: "dark-4", State: PRClosed, URL: url(9)})
	gh.merge(PullRequest{Number: 13, HeadRefName: "dark-5-totals", BaseRefName: "develop", URL: url(13)})
	gh.open(PullRequest{Number: 14, HeadRefName: "dark-5-totals", BaseRefName: "dark-4", URL: url(14), IsCrossRepository: true})
	r.pollOnce(t.Context(), seen)
	if got := rec.written(); !slices.Equal(got, []string{"reader DARK-3 #7 open"}) {
		t.Fatalf("after the first Poll: %v", got)
	}
	r.pollOnce(t.Context(), seen)
	if got := rec.written(); len(got) != 1 {
		t.Fatalf("a second Poll wrote again: %v", got)
	}

	gh.merge(PullRequest{Number: 7, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", Title: "Fix the cart", URL: url(7)})
	gh.merge(PullRequest{Number: 10, HeadRefName: "dark-5-totals-again", BaseRefName: "dark-4", URL: url(10)})
	gh.open(PullRequest{Number: 11, HeadRefName: "dark-5-totals-more", BaseRefName: "dark-4", URL: url(11)})
	r.pollOnce(t.Context(), seen)
	// DARK-5's #10 merged wins over its newer #11, open.
	want := []string{"reader DARK-3 #7 merged", "reader DARK-3 #7 open", "reader DARK-5 #10 merged"}
	sorted := func() []string { return slices.Sorted(slices.Values(rec.written())) }
	if got := sorted(); !slices.Equal(got, want) {
		t.Fatalf("after the merge: %v, want %v", got, want)
	}

	// A Runner started again reads the same pull requests: the Task carries them already.
	r2 := pollRunner(t, rec, gh)
	r2.pollOnce(t.Context(), map[string]bool{})
	if got := sorted(); !slices.Equal(got, want) {
		t.Fatalf("a new Runner wrote what the Tasks carry: %v", got)
	}
}

// The poller writes a Task's pull request as the Runner's agent that held the Task last, else as
// one of its agents in the Task's Project, else as the reader; when that is refused forbidden it
// says no agent may, and does not try every token. A refusal the record will repeat is not tried
// again; another failure is, next Poll.
func TestPollerWritesAsTheTasksAgent(t *testing.T) {
	rec := mergeFixture()
	builder := &taskRecord{name: "builder", tasks: rec.tasks, wss: rec.wss}
	tester := &taskRecord{name: "tester", tasks: rec.tasks, wss: rec.wss, projects: []client.Project{{ID: "p-dark"}}}
	at := time.Date(2026, 10, 10, 9, 0, 0, 0, time.UTC)
	rec.tasks[0].Claims = []client.Claim{{HolderID: "m-tester", StartedAt: at}, {HolderID: "m-builder", StartedAt: at.Add(time.Hour)},
		{HolderID: "m-ada", StartedAt: at.Add(2 * time.Hour)}}
	other := &client.TaskDetail{Task: client.Task{ID: "t-7", Key: "OPS-7", Title: "Deploy", State: client.TaskStateOpen, ProjectID: "p-ops"}}
	rec.tasks = append(rec.tasks, other)
	builder.tasks, tester.tasks = rec.tasks, rec.tasks
	rec.wss["t-7"] = rec.wss["t-3"]
	gh := &recordingGitHub{}
	url := func(n int64) string { return fmt.Sprintf("https://github.com/acme/web/pull/%d", n) }
	gh.open(PullRequest{Number: 7, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", URL: url(7)})
	gh.open(PullRequest{Number: 8, HeadRefName: "dark-5-totals", BaseRefName: "dark-4", URL: url(8)})
	gh.open(PullRequest{Number: 9, HeadRefName: "ops-7-deploy", BaseRefName: "main", URL: url(9)})
	rec.refuse = map[string]client.ErrorCode{"OPS-7": client.ErrorCodeForbidden}
	r := pollRunner(t, rec, gh, builder, tester)
	seen := map[string]bool{}
	r.pollOnce(t.Context(), seen)
	if got := builder.written(); !slices.Equal(got, []string{"builder DARK-3 #7 open"}) {
		t.Fatalf("the agent that held DARK-3 last wrote %v", got)
	}
	if got := tester.written(); !slices.Equal(got, []string{"tester DARK-5 #8 open"}) {
		t.Fatalf("the agent in DARK-5's Project wrote %v", got)
	}
	if got := rec.written(); len(got) != 0 || !seen["/src/web#9:open"] {
		t.Fatalf("the reader wrote %v; seen %v", got, seen)
	}

	builder.refuse = map[string]client.ErrorCode{"DARK-3": client.ErrorCodeConflict}
	tester.refuse = map[string]client.ErrorCode{"DARK-5": client.ErrorCodeInternal}
	gh.merge(PullRequest{Number: 7, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", URL: url(7)})
	gh.merge(PullRequest{Number: 8, HeadRefName: "dark-5-totals", BaseRefName: "dark-4", URL: url(8)})
	r.pollOnce(t.Context(), seen)
	if !seen["/src/web#7:merged"] || seen["/src/web#8:merged"] {
		t.Fatalf("a conflict is not tried again and a failure is: %v", seen)
	}
	tester.refuse = nil
	r.pollOnce(t.Context(), seen)
	if !seen["/src/web#8:merged"] || !slices.Contains(tester.written(), "tester DARK-5 #8 merged") {
		t.Fatalf("the write was not tried again: %v", tester.written())
	}
}

// The server checks a merged write by asking this Runner's PullRequest before it answers: the
// poller holds nothing that call needs, so both complete.
func TestPollerWriteCallsBackIntoTheRunner(t *testing.T) {
	rec := mergeFixture()
	gh := &recordingGitHub{}
	gh.merge(PullRequest{Number: 7, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", URL: "https://github.com/acme/web/pull/7"})
	r := pollRunner(t, rec, gh)
	var checked []string
	rec.setHook = func(task string, pr client.PullRequest) error {
		got, err := r.PullRequest(context.Background(), task, pr.Number, pr.URL)
		if err != nil {
			return err
		}
		checked = append(checked, fmt.Sprintf("%s #%d %s", task, got.Number, got.State))
		return nil
	}
	done := make(chan struct{})
	go func() {
		r.pollOnce(t.Context(), map[string]bool{})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the poller and the server's check wait on each other")
	}
	if !slices.Equal(checked, []string{"DARK-3 #7 merged"}) || !slices.Equal(rec.written(), []string{"reader DARK-3 #7 merged"}) {
		t.Fatalf("checked %v, written %v", checked, rec.written())
	}
}

// At a Shift's end the Runner reads the pull requests of the Task's branch in each Workspace in
// pull_request mode and writes the newest that is its landing on the Task, as the Shift; a closed
// one, one into another base and one from a fork are not, and a plain Workspace is not looked at.
func TestShiftEndReadsTheTasksPullRequest(t *testing.T) {
	rec := mergeFixture()
	rec.name = "builder"
	web := rec.wss["t-3"][0]
	plain := Workspace{ID: "w-docs", Name: "docs", Path: "/src/docs", Mode: ModePlain}
	gh := byRepo{"/src/web": {}, "/src/docs": {}}
	gh["/src/web"].set(PullRequest{Number: 5, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", State: PRClosed, URL: "https://github.com/acme/web/pull/5"})
	gh["/src/web"].open(PullRequest{Number: 7, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", URL: "https://github.com/acme/web/pull/7"})
	gh["/src/web"].open(PullRequest{Number: 8, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "develop", URL: "https://github.com/acme/web/pull/8"})
	gh["/src/web"].open(PullRequest{Number: 9, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", URL: "https://github.com/acme/web/pull/9",
		IsCrossRepository: true})
	gh["/src/docs"].open(PullRequest{Number: 2, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", URL: "https://github.com/acme/docs/pull/2"})
	r := pollRunner(t, rec, gh)
	s := &session{r: r, rec: rec, d: rec.tasks[0], key: "DARK-3", taskID: "t-3", log: r.log,
		checkouts: []Checkout{{Workspace: plain, Branch: "dark-3-fix-the-cart"}, {Workspace: web, Branch: "dark-3-fix-the-cart"}}}
	s.readPullRequests(t.Context())
	if got := rec.written(); !slices.Equal(got, []string{"builder DARK-3 #7 open"}) {
		t.Fatalf("at the Shift's end: %v", got)
	}

	gh["/src/web"].prs = []PullRequest{{Number: 5, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", State: PRClosed}}
	s.readPullRequests(t.Context())
	if got := rec.written(); len(got) != 1 {
		t.Fatalf("a closed pull request was written: %v", got)
	}
}

// A pull request whose branch names a Task not filed yet is written once the Task is: the Runner
// reads the Task again once the Activity stream says a Task was filed, and not every Poll before.
func TestPollerWaitsForTheTask(t *testing.T) {
	rec := mergeFixture()
	later := rec.tasks[0]
	rec.tasks = rec.tasks[1:]
	gh := &recordingGitHub{}
	gh.open(PullRequest{Number: 7, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", URL: "https://github.com/acme/web/pull/7"})
	rec.wss["t-5"] = rec.wss["t-3"]
	r := pollRunner(t, rec, gh)
	seen := map[string]bool{}
	gh.open(PullRequest{Number: 8, HeadRefName: "fix-123-foo", BaseRefName: "main", URL: "https://github.com/acme/web/pull/8"})
	r.pollOnce(t.Context(), seen)
	r.pollOnce(t.Context(), seen)
	rec.mu.Lock()
	reads := rec.reads["FIX-123"] + rec.reads["DARK-3"]
	rec.tasks = append(rec.tasks, later)
	rec.mu.Unlock()
	if reads != 2 {
		t.Fatalf("the Tasks no branch names were read %d times in two Polls", reads)
	}
	r.pollOnce(t.Context(), seen)
	if got := rec.written(); len(got) != 0 {
		t.Fatalf("written before a Task was filed: %v", got)
	}
	r.dispatch(client.Activity{Kind: client.ActivityKindTaskFiled, SubjectID: later.Task.ID})
	r.pollOnce(t.Context(), seen)
	if got := rec.written(); !slices.Equal(got, []string{"reader DARK-3 #7 open"}) {
		t.Fatalf("written %v", got)
	}
}

// A merged pull request of the Task's branch wins over a newer open one: the branch has landed.
// Among open ones the newest by number; a closed one never.
func TestNewestPullRequest(t *testing.T) {
	for _, tc := range []struct {
		prs  []PullRequest
		want int64
	}{
		{[]PullRequest{{Number: 8, State: PROpen}, {Number: 7, State: PRMerged}}, 7},
		{[]PullRequest{{Number: 7, State: PROpen}, {Number: 9, State: PROpen}, {Number: 8, State: PRClosed}}, 9},
		{[]PullRequest{{Number: 6, State: PRMerged}, {Number: 7, State: PRMerged}, {Number: 9, State: PROpen}}, 7},
		{[]PullRequest{{Number: 9, State: PRClosed}}, 0},
	} {
		got, ok := newestPullRequest(tc.prs)
		if got.Number != tc.want || ok != (tc.want != 0) {
			t.Errorf("newestPullRequest(%+v) = #%d, %v; want #%d", tc.prs, got.Number, ok, tc.want)
		}
	}

	// On the Task: #8 opened, then #7 merged.
	rec := mergeFixture()
	gh := &recordingGitHub{}
	r := pollRunner(t, rec, gh)
	seen := map[string]bool{}
	gh.open(PullRequest{Number: 7, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", URL: "https://github.com/acme/web/pull/7"})
	gh.open(PullRequest{Number: 8, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", URL: "https://github.com/acme/web/pull/8"})
	r.pollOnce(t.Context(), seen)
	gh.merge(PullRequest{Number: 7, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", URL: "https://github.com/acme/web/pull/7"})
	r.pollOnce(t.Context(), seen)
	if pr := rec.tasks[0].Task.PullRequest; pr == nil || pr.Number != 7 || pr.State != client.PullRequestMerged {
		t.Fatalf("DARK-3 carries %+v", pr)
	}
}

func (f *taskRecord) Attach(_ context.Context, task, filename string, kind client.EvidenceKind, claim string, _ []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if code, ok := f.refuse[task]; ok {
		return &remote.Error{Status: 500, Code: code, Message: "refused"}
	}
	f.writes = append(f.writes, fmt.Sprintf("%s attached %s to %s as %s under %s", f.name, filename, task, kind, claim))
	return nil
}

// A Shift's log names the Shift's Claim, attached at once or kept and attached by a Runner started
// again: the kept log's record carries the Claim.
func TestShiftsLogNamesItsClaim(t *testing.T) {
	rec := mergeFixture()
	rec.name = "builder"
	r := pollRunner(t, rec, &recordingGitHub{})
	a := r.agents[0]
	logPath := filepath.Join(t.TempDir(), "pane.log")
	if err := os.WriteFile(logPath, []byte("fakeagent: working\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	started := time.Date(2026, 10, 10, 10, 15, 0, 0, time.UTC)
	s := &session{r: r, a: a, rec: rec, key: "DARK-3", taskID: "t-3", claimID: "c-1", started: started, logPath: logPath, log: r.log}
	s.attachLog(t.Context())
	if got := rec.written(); !slices.Equal(got, []string{"builder attached shift-DARK-3-builder-101500.log to DARK-3 as log under c-1"}) {
		t.Fatalf("attached %v", got)
	}

	rec.refuse = map[string]client.ErrorCode{"DARK-3": client.ErrorCodeInternal}
	s.attachLog(t.Context())
	b, err := os.ReadFile(filepath.Join(r.cfg.Data, "sessions", "DARK-3", keptDir, "shift-DARK-3-builder-101500.log.json"))
	if err != nil {
		t.Fatal(err)
	}
	var k keptLog
	if err := json.Unmarshal(b, &k); err != nil || k.Claim != "c-1" {
		t.Fatalf("the kept log's record %s: %v", b, err)
	}
	rec.refuse = nil
	r.attachKeptOnce(t.Context())
	if got := rec.written(); len(got) != 2 || got[1] != "builder attached shift-DARK-3-builder-101500.log to DARK-3 as log under c-1" {
		t.Fatalf("attached %v", got)
	}
}

// A pull request into another base is not the Task's landing this Poll; retargeted on GitHub to the
// branch's own base, it is the next.
func TestPollerSeesARetargetedPullRequest(t *testing.T) {
	rec := mergeFixture()
	gh := &recordingGitHub{}
	r := pollRunner(t, rec, gh)
	seen := map[string]bool{}
	gh.open(PullRequest{Number: 8, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "develop", URL: "https://github.com/acme/web/pull/8"})
	r.pollOnce(t.Context(), seen)
	if got := rec.written(); len(got) != 0 {
		t.Fatalf("written %v", got)
	}
	gh.open(PullRequest{Number: 8, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", URL: "https://github.com/acme/web/pull/8"})
	r.pollOnce(t.Context(), seen)
	if got := rec.written(); !slices.Equal(got, []string{"reader DARK-3 #8 open"}) {
		t.Fatalf("written %v", got)
	}
}
