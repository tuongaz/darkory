package runner

import (
	"context"
	"errors"
	"fmt"
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
	refuse  string
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

func (g *recordingGitHub) MergePR(_ context.Context, _ string, n int64) error {
	g.mu.Lock()
	defer g.mu.Unlock()
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
	f.gh = gh
	f.run("builder", "reviewer")
	f.ok("ada", "file", "--project", "WEB", "--title", "Checkout")
	f.ok("ada", "file", "--parent", "WEB-1", "--title", "Cart page")
	eventually(t, 20*time.Second, "WEB-2 advanced to Review", func() bool {
		d := f.task("WEB-2")
		return d.Step != nil && d.Step.Name == "Review" && d.Task.Claim == nil
	})
	if !branchExists(t.Context(), f.repo, "web-1") {
		t.Fatal("no Parent's branch for the pull request's base")
	}
	// A pull request with no Task's key, and the Parent's own, are not reviews.
	gh.merge(PullRequest{Number: 5, Title: "Bump the linter", HeadRefName: "chore/lint", URL: "https://github.com/acme/web/pull/5"})
	gh.merge(PullRequest{Number: 6, Title: "WEB-1: Checkout", HeadRefName: "web-1", URL: "https://github.com/acme/web/pull/6"})
	gh.merge(PullRequest{Number: 7, Title: "WEB-2: Cart page", HeadRefName: "web-2-cart-page", URL: "https://github.com/acme/web/pull/7"})
	eventually(t, 20*time.Second, "WEB-2's review completed by its pull request", func() bool { return f.task("WEB-2").Task.State == client.TaskStateDone })
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
	name  string
	tasks []*client.TaskDetail
	wss   map[string][]Workspace // by Task id

	mu      sync.Mutex
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
func (g byRepo) MergePR(ctx context.Context, repo string, n int64) error {
	return g[repo].MergePR(ctx, repo, n)
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
			{Task: client.Task{ID: "t-3", Key: "DARK-3", Title: "Fix the cart", State: client.TaskStateDone}},
			{Task: client.Task{ID: "t-5", Key: "DARK-5", Title: "Totals", State: client.TaskStateDone},
				Parent: &client.TaskBrief{ID: "t-4", Key: "DARK-4", Title: "Checkout"}},
		},
		wss: map[string][]Workspace{"t-3": {web}, "t-5": {web}}}
}

// Merge merges the Task's pull request when its head is the Task's branch, by its key's prefix
// whatever the title says now, and its base the branch's own: the default branch for a Task
// standing alone, the Parent's branch for a Subtask. It refuses a foreign head or base in words
// the Owner reads, finds no pull request when GitHub has it closed, merged or not at all, and
// passes GitHub's refusal on as GitHub said it. It writes nothing on the Task.
func TestRunnerMerge(t *testing.T) {
	for _, tc := range []struct {
		name   string
		task   string
		pr     PullRequest
		refuse string
		want   string // the error, "" for a merge
		noPR   bool
	}{
		{name: "head and base match", task: "t-3", pr: PullRequest{HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", State: PROpen}},
		{name: "a renamed Task", task: "t-3", pr: PullRequest{HeadRefName: "dark-3-old-title", BaseRefName: "main", State: PROpen}},
		{name: "a foreign head", task: "t-3", pr: PullRequest{HeadRefName: "dark-9-other", BaseRefName: "main", State: PROpen},
			want: "pull request #7's branch dark-9-other is not DARK-3's"},
		{name: "a longer key", task: "t-3", pr: PullRequest{HeadRefName: "dark-30-cart", BaseRefName: "main", State: PROpen},
			want: "pull request #7's branch dark-30-cart is not DARK-3's"},
		{name: "a foreign base", task: "t-3", pr: PullRequest{HeadRefName: "dark-3-fix-the-cart", BaseRefName: "develop", State: PROpen},
			want: "pull request #7 is into develop, not main"},
		{name: "a Subtask into its Parent's branch", task: "t-5", pr: PullRequest{HeadRefName: "dark-5-totals", BaseRefName: "dark-4", State: PROpen}},
		{name: "a Subtask into main", task: "t-5", pr: PullRequest{HeadRefName: "dark-5-totals", BaseRefName: "main", State: PROpen},
			want: "pull request #7 is into main, not dark-4"},
		{name: "closed", task: "t-3", pr: PullRequest{HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", State: PRClosed}, noPR: true},
		{name: "merged already", task: "t-3", pr: PullRequest{HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", State: PRMerged}, noPR: true},
		{name: "GitHub refuses", task: "t-3", pr: PullRequest{HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", State: PROpen},
			refuse: "gh pr merge 7: exit status 1: X Pull request acme/web#7 is not mergeable: the merge commit cannot be cleanly created.",
			want:   "gh pr merge 7: exit status 1: X Pull request acme/web#7 is not mergeable: the merge commit cannot be cleanly created."},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gh := &recordingGitHub{refuse: tc.refuse}
			tc.pr.Number, tc.pr.URL = 7, "https://github.com/acme/web/pull/7"
			gh.set(tc.pr)
			rec := mergeFixture()
			r := mergeRunner(t, rec, gh)
			err := r.Merge(tc.task, 7)
			switch {
			case tc.noPR:
				if !errors.Is(err, runnerapi.ErrNoPullRequest) {
					t.Fatalf("Merge: %v, want ErrNoPullRequest", err)
				}
			case tc.want == "":
				if err != nil {
					t.Fatalf("Merge: %v", err)
				}
				if !slices.Equal(gh.merges, []int64{7}) {
					t.Fatalf("merged %v", gh.merges)
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

	// A number no Workspace of the Task has: no pull request.
	r := mergeRunner(t, mergeFixture(), &recordingGitHub{})
	if err := r.Merge("t-3", 8); !errors.Is(err, runnerapi.ErrNoPullRequest) {
		t.Fatalf("Merge of a missing pull request: %v", err)
	}
}

// PullRequest reads the Task's pull request in its Workspaces in pull_request mode, its state in
// lower case; of two Workspaces with the number, the one whose head is the Task's branch.
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

	pr, err := r.PullRequest("t-3", 7)
	if err != nil {
		t.Fatal(err)
	}
	want := runnerapi.PullRequest{Number: 7, URL: "https://github.com/acme/web/pull/7", State: "merged", Head: "dark-3-fix-the-cart", Base: "main"}
	if pr != want {
		t.Fatalf("PullRequest: %+v, want %+v", pr, want)
	}
	for state, lower := range map[string]string{PROpen: "open", PRClosed: "closed"} {
		gh["/src/web"].set(PullRequest{Number: 7, HeadRefName: "dark-3-fix-the-cart", BaseRefName: "main", State: state})
		if pr, err := r.PullRequest("t-3", 7); err != nil || pr.State != lower {
			t.Fatalf("PullRequest of a %s one: %+v, %v", state, pr, err)
		}
	}
	// Only another branch's #7 in a pull_request Workspace (the plain one's is not looked at): that
	// one, for the server to refuse by its head.
	gh["/src/web"].prs = nil
	if pr, err := r.PullRequest("t-3", 7); err != nil || pr.Head != "chore/bump" {
		t.Fatalf("PullRequest with only another branch's #7: %+v, %v", pr, err)
	}
	if _, err := r.PullRequest("t-3", 9); !errors.Is(err, runnerapi.ErrNoPullRequest) {
		t.Fatalf("PullRequest of a missing one: %v", err)
	}
}
