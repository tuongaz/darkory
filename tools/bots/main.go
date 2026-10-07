// Command bots runs a preset Organisation's agent Members and human personas against a live
// Install, so there is something to watch (tools/bots/bot): the software team (a planner, two
// builders, a reviewer, a retro, a lapser, a stuck agent and a backlog prober, with kai and mai)
// or the accounting firm (a planner, a drafter, a tax reviewer and a retro, with Mai Tran and Kai
// Nguyen), working at a human pace. Given an admin token it makes the Teams, Skills, Statuses,
// Workspaces and Members the preset needs if they are missing (by name), issues the bots fresh
// tokens, files the preset's Features when too few have work left, and prints what each bot does
// as it does it. It revokes the tokens it issued when it stops, which ends the Claims its bots
// still hold.
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
	workspaceRoot := fs.String("workspace-root", filepath.Join(or(os.Getenv("DARKORY_DATA"), ".dev"), "bots"),
		"where a preset's Workspaces get their throwaway git repositories, one directory each (default: bots in DARKORY_DATA, else in .dev)")
	paceName := fs.String("pace", "human", "human: a builder takes 30–90 s a Task; fast: under a second")
	length := fs.Duration("for", 10*time.Minute, "how long to run; 0 runs until interrupted")
	team := fs.String("team", "", "the key of the Team whose Features the bots work (default: the preset's first, WEB or BOOK)")
	teamName := fs.String("team-name", "", "its name, if it must be created")
	ops := fs.String("ops", "", "the key of the preset's second Team (default: OPS, whose chores the lapser and stuck take, or TAX)")
	opsName := fs.String("ops-name", "", "its name, if it must be created")
	ask := fs.String("ask", "", "the Member the agents' questions are aimed at (default: the preset's persona with --humans, else the admin)")
	features := fs.Int("features", 3, "keep this many of the preset's Features with work left to do, filing more as they run out")
	ship := fs.Bool("ship", false, "ship, as the admin, the Features it filed and owns once their Tasks have ended, dropping what waited in the Backlog, so retro and the reviewer get work (the owning persona does this with --humans)")
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
	crew, err := bot.Setup(ctx, admin, bot.Options{Preset: preset, Team: *team, TeamName: *teamName, Ops: *ops, OpsName: *opsName, Ask: *ask,
		WorkspaceRoot: *workspaceRoot, Timeout: pace.Timeout, TokenName: "tools/bots " + time.Now().Format("2006-01-02 15:04")})
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
	var names, teams, people []string
	for _, s := range preset.Agents {
		names = append(names, s.Name)
	}
	for _, t := range preset.Teams {
		teams = append(teams, crew.TeamKey(t.Key))
	}
	for _, p := range crew.Personas {
		people = append(people, p.Name)
	}
	out.printf("preset %s on %s as %s: %s in %s, reporting to %s, asking %s; %s; Features owned by %s; pace %s, for %s",
		preset.Name, *url, crew.Admin.Name, strings.Join(names, ", "), strings.Join(teams, " and "), crew.Manager, crew.Ask,
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
	o := &owner{c: admin, crew: crew, out: out, features: *features, ship: *ship}
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

// owner stands in for the admin who keeps work coming: it files the preset's Features, in turn,
// when too few have work left, and the chores the lapser and stuck take; with ship, it ships what
// it owns once it has ended.
type owner struct {
	c        *client.ClientWithResponses
	crew     *bot.Crew
	out      *printer
	features int
	ship     bool
	// idle are the Features whose only open Tasks were in the Backlog when last tended.
	idle map[string]bool
}

func (o *owner) shipIt(ctx context.Context, f client.Feature) error {
	res, err := o.c.ShipFeatureWithResponse(ctx, f.Key, &client.ShipFeatureParams{})
	if err := check(res, err, http.StatusOK); err != nil {
		return fmt.Errorf("shipping %s: %w", f.Key, err)
	}
	o.out.printf("owner shipped %s %q; its Retrospective waits for retro", f.Key, f.Title)
	return nil
}

// teams are the keys of the Teams the preset's Features are filed in.
func (o *owner) teams() []string {
	var keys []string
	for _, t := range o.crew.Preset.Features {
		if k := o.crew.TeamKey(or(t.Team, o.crew.Preset.Teams[0].Key)); !slices.Contains(keys, k) {
			keys = append(keys, k)
		}
	}
	return keys
}

func (o *owner) tend(ctx context.Context) error {
	if err := o.chores(ctx); err != nil {
		return err
	}
	statuses, err := o.c.ListStatusesWithResponse(ctx)
	if err := check(statuses, err, http.StatusOK); err != nil {
		return err
	}
	backlog := map[string]bool{}
	for _, s := range statuses.JSON200.Items {
		backlog[s.ID] = s.Kind == client.StatusKindBacklog
	}
	busy := 0
	idle := map[string]bool{}
	for _, team := range o.teams() {
		open := client.FeatureStateOpen
		res, err := o.c.ListFeaturesWithResponse(ctx, &client.ListFeaturesParams{Team: &team, State: &open, Limit: ptr(500)})
		if err := check(res, err, http.StatusOK); err != nil {
			return err
		}
		for _, f := range res.JSON200.Items {
			mine := o.ship && f.OwnerID == o.crew.Admin.ID
			if f.TaskCounts.Open == 0 {
				if mine {
					if err := o.shipIt(ctx, f); err != nil {
						return err
					}
				}
				continue
			}
			// Work left is an open Task outside the Backlog: what a Feature has only there waits for
			// a person to move it.
			tasks, err := o.c.ListTasksWithResponse(ctx, &client.ListTasksParams{Feature: &f.Key, State: ptr(client.TaskStateOpen), Limit: ptr(500)})
			if err := check(tasks, err, http.StatusOK); err != nil {
				return err
			}
			if slices.ContainsFunc(tasks.JSON200.Items, func(t client.Task) bool { return !backlog[t.StatusID] }) {
				busy++
				continue
			}
			// With ship, what still waits in the Backlog a round after the rest ended is dropped, and
			// the Feature ships without it.
			if !mine {
				continue
			}
			if !o.idle[f.ID] {
				idle[f.ID] = true
				continue
			}
			for _, t := range tasks.JSON200.Items {
				dres, err := o.c.DropTaskWithResponse(ctx, t.Key, &client.DropTaskParams{}, client.DropTaskBody{Reason: ptr("Shipping without it; file it again if it matters.")})
				if err := check(dres, err, http.StatusOK); err != nil {
					return fmt.Errorf("dropping %s: %w", t.Key, err)
				}
				o.out.printf("owner dropped %s %q, left in the Backlog", t.Key, t.Title)
			}
			if err := o.shipIt(ctx, f); err != nil {
				return err
			}
		}
	}
	o.idle = idle
	for ; busy < o.features; busy++ {
		if err := o.file(ctx); err != nil {
			return err
		}
	}
	return nil
}

// file files the preset's next Feature, numbered once every template has been filed under its own
// title, owned by the crew's Owner; it comes with its Break down, or, quick, with its one Task.
func (o *owner) file(ctx context.Context) error {
	taken := map[string]bool{}
	for _, team := range o.teams() {
		all, err := o.c.ListFeaturesWithResponse(ctx, &client.ListFeaturesParams{Team: &team, Limit: ptr(500)})
		if err := check(all, err, http.StatusOK); err != nil {
			return err
		}
		for _, f := range all.JSON200.Items {
			taken[f.Title] = true
		}
	}
	var next bot.FeatureTemplate
	title := ""
	for n := 1; title == ""; n++ {
		for _, t := range o.crew.Preset.Features {
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
	if d.Feature.Quick {
		o.out.printf("owner filed %s %q for %s, a quick Feature with its one Task %s", d.Feature.Key, title, o.crew.Owner, d.Tasks[0].Key)
		return nil
	}
	o.out.printf("owner filed %s %q for %s; the planner will break it down", d.Feature.Key, title, o.crew.Owner)
	return nil
}

// chores keeps an open Task for each of the preset's chores in its Team, on a Chores Feature whose
// Break down the owner completes, since nobody there plans.
func (o *owner) chores(ctx context.Context) error {
	feature := map[string]string{}
	for _, c := range o.crew.Preset.Chores {
		team := o.crew.TeamKey(c.Team)
		res, err := o.c.ListTasksWithResponse(ctx, &client.ListTasksParams{Team: &team, Skill: &c.Skill, State: ptr(client.TaskStateOpen), Limit: ptr(1)})
		if err := check(res, err, http.StatusOK); err != nil {
			return err
		}
		if len(res.JSON200.Items) > 0 {
			continue
		}
		if feature[team] == "" {
			f, err := o.choresFeature(ctx, team)
			if err != nil {
				return err
			}
			feature[team] = f
		}
		key := feature[team]
		tres, err := o.c.FileTaskWithResponse(ctx, &client.FileTaskParams{}, client.FileTaskBody{Feature: &key, Title: c.Title, Skill: &c.Skill})
		if err := check(tres, err, http.StatusCreated); err != nil {
			return fmt.Errorf("filing %q: %w", c.Title, err)
		}
		o.out.printf("owner filed %s %q needing %s", tres.JSON201.Task.Key, c.Title, c.Skill)
	}
	return nil
}

// choresFeature returns the open Chores Feature of team, filing it if there is none.
func (o *owner) choresFeature(ctx context.Context, team string) (string, error) {
	open := client.FeatureStateOpen
	res, err := o.c.ListFeaturesWithResponse(ctx, &client.ListFeaturesParams{Team: &team, State: &open, Limit: ptr(500)})
	if err := check(res, err, http.StatusOK); err != nil {
		return "", err
	}
	for _, f := range res.JSON200.Items {
		if f.Title == "Chores" {
			return f.Key, nil
		}
	}
	fres, err := o.c.FileFeatureWithResponse(ctx, &client.FileFeatureParams{}, client.FileFeatureBody{Team: team, Title: "Chores",
		Description: ptr("Recurring operations work.")})
	if err := check(fres, err, http.StatusCreated); err != nil {
		return "", fmt.Errorf("filing Chores: %w", err)
	}
	key := fres.JSON201.Feature.Key
	o.out.printf("owner filed %s \"Chores\"", key)
	for _, t := range fres.JSON201.Tasks {
		if t.Kind != client.Breakdown {
			continue
		}
		cres, err := o.c.ClaimTaskWithResponse(ctx, t.Key, &client.ClaimTaskParams{}, client.ClaimTaskBody{HeartbeatTimeoutSeconds: ptr(0)})
		if err := check(cres, err, http.StatusOK); err != nil {
			return "", fmt.Errorf("claiming %s: %w", t.Key, err)
		}
		dres, err := o.c.CompleteTaskWithResponse(ctx, t.Key, &client.CompleteTaskParams{}, client.CompleteTaskBody{Note: ptr("Chores are filed by hand.")})
		if err := check(dres, err, http.StatusOK); err != nil {
			return "", fmt.Errorf("completing %s: %w", t.Key, err)
		}
	}
	return key, nil
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
