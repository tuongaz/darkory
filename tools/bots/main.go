// Command bots runs a preset Organisation's agent Members and human personas against a live
// Install, so there is something to watch (tools/bots/bot): the software crew (a planner, two
// builders, a reviewer, a retro, a lapser, a stuck agent and a backlog prober, with kai and mai)
// or the accounting practice (people alone: Lan Pham, Mai Tran and Kai Nguyen), working at a human
// pace. Given an admin token it makes the Projects, Skills, Workflows, Workspaces and Members the
// preset needs if they are missing (by name), issues the bots fresh tokens, files the preset's
// Tasks when too few have work left, and prints what each bot does as it does it. It revokes the
// tokens it issued when it stops, which ends the Claims its bots still hold.
//
//	go run ./tools/bots --url http://127.0.0.1:7357 --preset accounting --pace human --for 10m
//
// with the admin token in DARKORY_TOKEN (or --token). docs/build/testing.md, "Bots", says more.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/tools/bots/bot"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "bots:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("bots", flag.ContinueOnError)
	url := fs.String("url", or(os.Getenv("DARKORY_URL"), "http://127.0.0.1:7357"), "the Install (DARKORY_URL)")
	token := fs.String("token", "", "an admin's token (DARKORY_TOKEN, which other processes cannot read as they can arguments)")
	presetName := fs.String("preset", "software", "the Organisation the bots make and work: software or accounting")
	humans := fs.Bool("humans", true, "run the preset's human personas too, each with a token of their own: they answer the questions, own the Tasks and complete them")
	workspaceRoot := fs.String("workspace-root", filepath.Join(or(os.Getenv("DARKORY_DATA"), ".dev"), "bots"),
		"where a preset's Workspaces get their throwaway git repositories, one directory each (default: bots in DARKORY_DATA, else in .dev)")
	paceName := fs.String("pace", "human", "human: a builder takes 30–90 s a Task; fast: under a second")
	length := fs.Duration("for", 10*time.Minute, "how long to run; 0 runs until interrupted")
	project := fs.String("project", "", "the key of the Project whose Tasks the bots work (default: the preset's first, WEB or TAX)")
	projectName := fs.String("project-name", "", "its name, if it must be created")
	ops := fs.String("ops", "", "the key of the software preset's second Project (default: OPS, whose chores the lapser and stuck take)")
	opsName := fs.String("ops-name", "", "its name, if it must be created")
	ask := fs.String("ask", "", "the Member the agents' questions are aimed at (default: the preset's persona with --humans, else the admin)")
	tasks := fs.Int("tasks", 3, "keep this many of the preset's Tasks with work left to do, filing more as they run out")
	complete := fs.Bool("complete", false, "complete, as the admin, the Parents it filed and owns once their Subtasks have ended, dropping what waited in the Backlog, so retro and the reviewer get work (the owning persona does this with --humans)")
	binary := fs.String("darkory", "", "the darkory binary stuck runs (default: build ./cmd/darkory from this checkout)")
	insecure := fs.Bool("insecure", false, "let stuck's CLI use plain http:// to a host other than this machine")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	preset := bot.Presets[*presetName]
	if preset == nil {
		return fmt.Errorf("--preset is software or accounting, not %q", *presetName)
	}
	if *token == "" {
		*token = os.Getenv("DARKORY_TOKEN")
	}
	if *token == "" {
		return errors.New("needs an admin's token: set DARKORY_TOKEN or pass --token")
	}
	var pace bot.Pace
	switch *paceName {
	case "human":
		pace = bot.Human
	case "fast":
		// The tests' pace, but the lapser and stuck keep at it rather than stopping.
		pace = bot.Fast
		pace.LapseEvery, pace.Rest = 10*time.Second, 10*time.Second
	default:
		return fmt.Errorf("--pace is human or fast, not %q", *paceName)
	}
	out := &printer{w: stdout, quiet: map[string]time.Time{}}
	if *binary == "" && slices.ContainsFunc(preset.Agents, func(s bot.Spec) bool { return s.Role == bot.RoleStuck }) {
		dir, err := os.MkdirTemp("", "darkory-bots-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(dir)
		*binary = filepath.Join(dir, "darkory")
		out.printf("building darkory for stuck's CLI")
		if err := build(ctx, *binary); err != nil {
			return err
		}
	}
	admin, err := bot.Dial(*url, nil, bot.Member{Token: *token, Session: bot.NewSession()})
	if err != nil {
		return err
	}
	crew, err := bot.Setup(ctx, admin, bot.Options{Preset: preset, Project: *project, ProjectName: *projectName, Ops: *ops, OpsName: *opsName, Ask: *ask,
		Personas: *humans, WorkspaceRoot: *workspaceRoot, Timeout: pace.Timeout, TokenName: "tools/bots " + time.Now().Format("2006-01-02 15:04")})
	if err != nil {
		return err
	}
	// Revoke the tokens even when interrupted, which ends the Claims the bots hold.
	defer func() {
		rctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := crew.Revoke(rctx, admin); err != nil {
			out.printf("revoking the bots' tokens: %v", err)
			return
		}
		out.printf("revoked the bots' %d tokens, ending any Claims they held", len(crew.Tokens))
	}()
	var names, projects, people []string
	for _, s := range preset.Agents {
		names = append(names, s.Name)
	}
	for _, t := range preset.Projects {
		projects = append(projects, crew.ProjectKey(t.Key))
	}
	for _, p := range crew.Personas {
		people = append(people, p.Name)
	}
	out.printf("preset %s on %s as %s: %s in %s, reporting to %s, asking %s; %s; Tasks owned by %s; pace %s, for %s",
		preset.Name, *url, crew.Admin.Name, or(strings.Join(names, ", "), "no agents"), strings.Join(projects, " and "), crew.Manager, crew.Ask,
		or(strings.Join(people, " and "), "no personas"), crew.Owner, pace.Name, or(length.String(), "ever"))
	for _, w := range crew.Workspaces {
		out.printf("Workspace %s is the git repository %s", w.Name, w.Path)
	}

	// The bots' time starts once they are set up.
	if *length > 0 {
		var cancel func()
		ctx, cancel = context.WithTimeout(ctx, *length)
		defer cancel()
	}
	o := &owner{c: admin, crew: crew, out: out, tasks: *tasks, complete: *complete}
	if err := o.tend(ctx); err != nil {
		return err
	}
	env := os.Environ()
	if *insecure {
		env = append(env, "DARKORY_INSECURE=1")
	}
	cfg := bot.Config{URL: *url, Pace: pace, Report: out.event, Binary: *binary, Env: env}
	var wg sync.WaitGroup
	for _, b := range crew.Bots(cfg) {
		wg.Go(func() {
			if err := b.Run(ctx); err != nil {
				out.printf("%s stopped: %v", b.Name(), err)
				return
			}
			if ctx.Err() == nil {
				out.printf("%s is done", b.Name())
			}
		})
	}
	every := 30 * time.Second
	if pace.Name == "fast" {
		every = 2 * time.Second
	}
	for sleep(ctx, every) {
		if err := o.tend(ctx); err != nil && ctx.Err() == nil {
			out.printf("owner: %v", err)
		}
	}
	out.printf("stopping")
	wg.Wait()
	out.summary()
	return nil
}

// build builds ./cmd/darkory from the module this command runs in.
func build(ctx context.Context, binary string) error {
	gomod, err := exec.CommandContext(ctx, "go", "env", "GOMOD").Output()
	if err != nil {
		return fmt.Errorf("finding the module: %w", err)
	}
	cmd := exec.CommandContext(ctx, "go", "build", "-o", binary, "./cmd/darkory")
	cmd.Dir = filepath.Dir(strings.TrimSpace(string(gomod)))
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("building darkory (or pass --darkory): %w", err)
	}
	return nil
}

// owner stands in for the admin who keeps work coming: it files the preset's Tasks, in turn,
// when too few have work left, and the chores the lapser and stuck take; with complete, it
// completes the Parents it owns once their Subtasks have ended.
type owner struct {
	c        *client.ClientWithResponses
	crew     *bot.Crew
	out      *printer
	tasks    int
	complete bool
	// idle are the Parents whose only open Subtasks were in the hold when last tended.
	idle map[string]bool
}

func (o *owner) completeIt(ctx context.Context, t client.Task) error {
	res, err := o.c.CompleteTaskWithResponse(ctx, t.Key, &client.CompleteTaskParams{}, client.CompleteTaskBody{})
	if err := check(res, err, http.StatusOK); err != nil {
		return fmt.Errorf("completing %s: %w", t.Key, err)
	}
	o.out.printf("owner completed %s %q; its Retrospective waits for retro", t.Key, t.Title)
	return nil
}

// projects are the keys of the Projects the preset's Tasks are filed in.
func (o *owner) projects() []string {
	var keys []string
	for _, t := range o.crew.Preset.Tasks {
		if k := o.crew.ProjectKey(or(t.Project, o.crew.Preset.Projects[0].Key)); !slices.Contains(keys, k) {
			keys = append(keys, k)
		}
	}
	return keys
}

// holdID is the id of the Workflow's hold in the Project project, or "" when it has none.
func (o *owner) holdID(ctx context.Context, project string) (string, error) {
	res, err := o.c.GetWorkflowWithResponse(ctx, project)
	if err := check(res, err, http.StatusOK); err != nil {
		return "", err
	}
	for _, s := range res.JSON200.Steps {
		if s.Name == o.crew.Preset.Workflow.Hold() {
			return s.ID, nil
		}
	}
	return "", nil
}

func (o *owner) tend(ctx context.Context) error {
	if err := o.chores(ctx); err != nil {
		return err
	}
	busy := 0
	idle := map[string]bool{}
	for _, project := range o.projects() {
		// Work left is an open Task outside the hold: what waits only there waits for a person to
		// move it.
		hold, err := o.holdID(ctx, project)
		if err != nil {
			return err
		}
		waiting := func(t client.Task) bool { return t.StepID != nil && *t.StepID == hold }
		top := []string{"top:is:true"}
		res, err := o.c.ListTasksWithResponse(ctx, &client.ListTasksParams{Project: &project, Filter: &top, State: ptr(client.TaskStateOpen), Limit: ptr(500)})
		if err := check(res, err, http.StatusOK); err != nil {
			return err
		}
		for _, t := range res.JSON200.Items {
			if t.SubtaskCounts == nil {
				if !waiting(t) && !o.chore(t) {
					busy++
				}
				continue
			}
			mine := o.complete && t.OwnerID == o.crew.Admin.ID
			if t.SubtaskCounts.Open == 0 {
				if mine {
					if err := o.completeIt(ctx, t); err != nil {
						return err
					}
				}
				continue
			}
			subs, err := o.c.ListTasksWithResponse(ctx, &client.ListTasksParams{Parent: &t.Key, State: ptr(client.TaskStateOpen), Limit: ptr(500)})
			if err := check(subs, err, http.StatusOK); err != nil {
				return err
			}
			if slices.ContainsFunc(subs.JSON200.Items, func(s client.Task) bool { return !waiting(s) }) {
				busy++
				continue
			}
			// With complete, what still waits in the hold a round after the rest ended is dropped, and
			// the Parent completes without it.
			if !mine {
				continue
			}
			if !o.idle[t.ID] {
				idle[t.ID] = true
				continue
			}
			for _, s := range subs.JSON200.Items {
				dres, err := o.c.DropTaskWithResponse(ctx, s.Key, &client.DropTaskParams{}, client.DropTaskBody{Reason: ptr("Completing without it; file it again if it matters.")})
				if err := check(dres, err, http.StatusOK); err != nil {
					return fmt.Errorf("dropping %s: %w", s.Key, err)
				}
				o.out.printf("owner dropped %s %q, left in the hold", s.Key, s.Title)
			}
			if err := o.completeIt(ctx, t); err != nil {
				return err
			}
		}
	}
	o.idle = idle
	for ; busy < o.tasks; busy++ {
		if err := o.file(ctx); err != nil {
			return err
		}
	}
	return nil
}

// chore says whether t is one of the preset's chores, which never count as work left.
func (o *owner) chore(t client.Task) bool {
	return slices.ContainsFunc(o.crew.Preset.Chores, func(c bot.Chore) bool { return c.Title == t.Title })
}

// file files the preset's next Task, numbered once every template has been filed under its own
// title, owned by the crew's Owner.
func (o *owner) file(ctx context.Context) error {
	taken := map[string]bool{}
	for _, project := range o.projects() {
		top := []string{"top:is:true"}
		all, err := o.c.ListTasksWithResponse(ctx, &client.ListTasksParams{Project: &project, Filter: &top, Limit: ptr(500)})
		if err := check(all, err, http.StatusOK); err != nil {
			return err
		}
		for _, t := range all.JSON200.Items {
			taken[t.Title] = true
		}
	}
	var next bot.TaskTemplate
	title := ""
	for n := 1; title == ""; n++ {
		for _, t := range o.crew.Preset.Tasks {
			tt := t.Title
			if n > 1 {
				tt = fmt.Sprintf("%s %d", tt, n)
			}
			if !taken[tt] {
				next, title = t, tt
				break
			}
		}
	}
	d, err := o.crew.File(ctx, o.c, next, title)
	if err != nil {
		return err
	}
	switch {
	case next.Breakdown:
		o.out.printf("owner filed %s %q for %s; the planner will break it down", d.Task.Key, title, o.crew.Owner)
	case len(d.Subtasks) > 0:
		o.out.printf("owner filed %s %q for %s, with %d Subtasks", d.Task.Key, title, o.crew.Owner, len(d.Subtasks))
	default:
		o.out.printf("owner filed %s %q for %s", d.Task.Key, title, o.crew.Owner)
	}
	return nil
}

// chores keeps an open Task for each of the preset's chores, alone at its Step in its Project.
func (o *owner) chores(ctx context.Context) error {
	for _, c := range o.crew.Preset.Chores {
		project := o.crew.ProjectKey(c.Project)
		res, err := o.c.ListTasksWithResponse(ctx, &client.ListTasksParams{Project: &project, Step: &c.Step, State: ptr(client.TaskStateOpen), Limit: ptr(1)})
		if err := check(res, err, http.StatusOK); err != nil {
			return err
		}
		if len(res.JSON200.Items) > 0 {
			continue
		}
		tres, err := o.c.FileTaskWithResponse(ctx, &client.FileTaskParams{}, client.FileTaskBody{Project: &project, Title: c.Title, Step: &c.Step})
		if err := check(tres, err, http.StatusCreated); err != nil {
			return fmt.Errorf("filing %q: %w", c.Title, err)
		}
		o.out.printf("owner filed %s %q at %s", tres.JSON201.Task.Key, c.Title, c.Step)
	}
	return nil
}

// printer writes what happens, one line each, from many goroutines.
type printer struct {
	mu    sync.Mutex
	w     io.Writer
	quiet map[string]time.Time // when each bot last said it found nothing
	whats map[string]int
}

func (p *printer) printf(format string, args ...any) {
	p.mu.Lock()
	defer p.mu.Unlock()
	fmt.Fprintf(p.w, "%s %s\n", time.Now().Format("15:04:05.000"), fmt.Sprintf(format, args...))
}

// event prints a bot's report, and an empty next at most once a minute per bot.
func (p *printer) event(e bot.Event) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.whats == nil {
		p.whats = map[string]int{}
	}
	p.whats[e.What]++
	if e.What == "nothing" {
		if time.Since(p.quiet[e.Bot]) < time.Minute {
			return
		}
		p.quiet[e.Bot] = time.Now()
	}
	fmt.Fprintln(p.w, e)
}

func (p *printer) summary() {
	p.mu.Lock()
	var parts []string
	for what, n := range p.whats {
		parts = append(parts, fmt.Sprintf("%s %d", what, n))
	}
	p.mu.Unlock()
	slices.Sort(parts)
	p.printf("in all: %s", strings.Join(parts, ", "))
}

type response interface {
	StatusCode() int
	GetBody() []byte
}

func check(res response, err error, ok ...int) error {
	if err != nil {
		return err
	}
	if !slices.Contains(ok, res.StatusCode()) {
		return fmt.Errorf("status %d: %s", res.StatusCode(), strings.TrimSpace(string(res.GetBody())))
	}
	return nil
}

func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func or(s, def string) string {
	if s == "" || s == "0s" {
		return def
	}
	return s
}

func ptr[T any](v T) *T { return &v }
