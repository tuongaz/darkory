package bot

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/tuongaz/darkory/client"
)

// Builder takes work through next and works it as the rules say: it heartbeats in the background,
// writes a Note, attaches a small Evidence file, and, when the Task's description has a question
// for someone, files that question aimed at them, blocking its own Task, and waits for the answer
// holding its Claim. Then it hands over to the Skill the description names, moving the Task to
// the review Status, or completes it with an Observation: didn't work when the Skill left it
// asking, worked otherwise. It reports its model label on every Claim.
//
// A prober is a Builder that asks next without waiting, every Pace.Poll, and reports each empty
// answer, to show which Tasks next does not offer.
type Builder struct {
	agent
	probe bool
}

// NewBuilder makes a builder.
func NewBuilder(cfg Config, m Member, model string) *Builder {
	return &Builder{agent: newAgent(cfg, m, model)}
}

// NewProber makes a builder that reports every time next offers it nothing.
func NewProber(cfg Config, m Member, model string) *Builder {
	b := NewBuilder(cfg, m, model)
	b.probe = true
	return b
}

// A Task's description asks a builder for something with lines such as these.
var (
	questionRe = regexp.MustCompile(`(?m)^Question for (\S+): (.+)$`)
	handoverRe = regexp.MustCompile(`(?m)^Hand over to (\S+) when built\.$`)
)

func questionLine(who, q string) string { return "Question for " + who + ": " + q }
func handoverLine(skill string) string  { return "Hand over to " + skill + " when built." }

func (b *Builder) Run(ctx context.Context) error {
	return b.loop(ctx, func() (bool, error) {
		wait := b.cfg.Pace.Wait
		if b.probe {
			wait = 0
		}
		d, err := b.next(ctx, wait, b.cfg.Pace.Timeout)
		if err != nil {
			return true, err
		}
		if d == nil {
			if b.probe {
				b.say("nothing", "", "next offered nothing")
				sleep(ctx, b.cfg.Pace.Poll)
			}
			return true, nil
		}
		b.took(d)
		return true, on(d.Task.Key, b.build(ctx, d))
	})
}

func (b *Builder) build(ctx context.Context, d *client.TaskDetail) error {
	key := d.Task.Key
	wctx, stop := b.hold(ctx, d)
	defer stop()
	skill := ""
	if d.Task.SkillID != nil {
		s, err := b.skill(wctx, *d.Task.SkillID)
		if err != nil {
			return gone(wctx, err)
		}
		skill = s.Skill.Name
	}
	// What the Task asks of its worker: its plan's Step says, or else lines of its description.
	step := b.step(d)
	var who, question, handover string
	if m := questionRe.FindStringSubmatch(d.Task.Description); m != nil {
		who, question = m[1], m[2]
	}
	if m := handoverRe.FindStringSubmatch(d.Task.Description); m != nil {
		handover = m[1]
	}
	// A Task handed back after review is reworked: the fix is appended and it goes to review again.
	rework := false
	if step != nil {
		if q := step.Question; q != nil {
			who, question = or(q.AimedAt, b.ask), q.Title
		}
		handover = or(step.Handover, handover)
		for _, c := range d.Claims {
			rework = rework || (c.HolderID == b.m.ID && c.HowEnded != nil && *c.HowEnded == client.ClaimEndHandedOver)
		}
	}

	total := b.work()
	if !sleep(wctx, total/3) {
		return nil
	}
	note := ""
	switch {
	case step == nil || step.Workpaper == "":
		first, _, _ := strings.Cut(d.Task.Description, "\n")
		note = fmt.Sprintf("Starting on %q. %s", d.Task.Title, first)
	case rework:
		note = fmt.Sprintf("Back from review, fixing %s.", step.Workpaper)
	default:
		note = fmt.Sprintf("Starting on %s, in %s.", d.Task.Title, step.Workpaper)
	}
	if err := b.note(wctx, key, note); err != nil {
		return gone(wctx, err)
	}
	if !sleep(wctx, total/3) {
		return nil
	}
	name, content, err := b.evidence(wctx, d, step, skill, rework)
	if err != nil {
		return gone(wctx, err)
	}
	if err := b.attach(wctx, key, name, content); err != nil {
		return gone(wctx, err)
	}

	// A question asked once, by whoever held the Task, is not asked again.
	asked := rework
	for _, bl := range d.Blockers {
		asked = asked || bl.AimedAtID != nil
	}
	if question != "" && !asked {
		asked = true
		answered, err := b.askAndWait(wctx, d, who, question)
		if err != nil || wctx.Err() != nil {
			return gone(wctx, err) // the Claim was lost while waiting, or the bot is stopping
		}
		if !answered {
			stop()
			if ctx.Err() != nil {
				return nil
			}
			return gone(ctx, b.release(ctx, key, fmt.Sprintf("Waiting for %s to answer; whoever takes it next can carry on once they have.", who)))
		}
	}
	if !sleep(wctx, total/3) {
		return nil
	}

	if handover != "" && handover != skill {
		status, err := b.reviewStatus(wctx)
		if err != nil {
			return gone(wctx, err)
		}
		stop()
		if ctx.Err() != nil {
			return nil
		}
		hnote := fmt.Sprintf("Built; %s is attached. Ready for %s.", name, handover)
		if step != nil && step.Workpaper != "" {
			hnote = fmt.Sprintf("The workpaper %s is attached and ready for %s.", name, handover)
		}
		return gone(ctx, b.handover(ctx, key, handover, status, hnote))
	}

	outcome, body := client.Worked, fmt.Sprintf("%s went as %s describes.", d.Task.Title, or(skill, "the Skill"))
	if question != "" && asked && !rework {
		outcome, body = client.DidntWork, fmt.Sprintf("%s did not answer this, so %s had to: %s", or(skill, "The Skill"), who, question)
	}
	res, err := b.c.ObserveWithResponse(wctx, key, &client.ObserveParams{}, client.ObserveBody{Outcome: outcome, Body: body})
	if err := check(res, err, http.StatusCreated); err != nil {
		return gone(wctx, err)
	}
	b.say("observed", key, "%s: %q", outcome, body)
	stop()
	if ctx.Err() != nil {
		return nil
	}
	_, err = b.complete(ctx, key, "Done; "+name+" is attached.")
	return gone(ctx, err)
}

// askAndWait files a question aimed at who that blocks d's Task, then waits, holding the Claim,
// until the Task is unblocked or Patience runs out. It says whether the question was answered.
func (b *Builder) askAndWait(wctx context.Context, d *client.TaskDetail, who, q string) (bool, error) {
	desc := fmt.Sprintf("%s asks while working %s %q.", b.m.Name, d.Task.Key, d.Task.Title)
	res, err := b.c.FileTaskWithResponse(wctx, &client.FileTaskParams{}, client.FileTaskBody{
		Title: q, AimedAt: &who, Blocks: &d.Task.Key, Description: &desc})
	if err := check(res, err, http.StatusCreated); err != nil {
		return false, err
	}
	qk := res.JSON201.Task.Key
	b.say("asked", d.Task.Key, "%s aimed at %s: %q; %s is blocked until it ends", qk, who, q, d.Task.Key)
	deadline := time.Now().Add(b.cfg.Pace.Patience)
	for time.Now().Before(deadline) {
		if !sleep(wctx, b.cfg.Pace.Poll) {
			return false, nil
		}
		res, err := b.c.GetTaskWithResponse(wctx, d.Task.Key)
		if err := check(res, err, http.StatusOK); err != nil {
			return false, err
		}
		if res.JSON200.Task.Blocked {
			continue
		}
		answer := "(no Note)"
		if qr, err := b.c.GetTaskWithResponse(wctx, qk); check(qr, err, http.StatusOK) == nil && len(qr.JSON200.Notes) > 0 {
			answer = qr.JSON200.Notes[len(qr.JSON200.Notes)-1].Body
		}
		b.say("answered", d.Task.Key, "%s ended; %s's answer: %q", qk, who, answer)
		return true, nil
	}
	return false, nil
}

// reviewStatus is the Status a Task handed over to review moves to: the in_progress Status whose
// name says review, else none, which leaves the Status as it is.
func (b *Builder) reviewStatus(ctx context.Context) (string, error) {
	list, err := b.listStatuses(ctx)
	if err != nil {
		return "", err
	}
	for _, s := range list {
		if s.Kind == client.StatusKindInProgress && strings.Contains(strings.ToLower(s.Name), "review") {
			return s.Name, nil
		}
	}
	return "", nil
}

// evidence is the file the builder attaches to d's Task: the workpaper its Step names, with the
// Step's line (or, on rework, its fix) appended, from the Task's first Workspace on this machine;
// the line alone when that Workspace is elsewhere; else the preset's file for the Skill.
func (b *Builder) evidence(ctx context.Context, d *client.TaskDetail, step *Step, skill string, rework bool) (string, string, error) {
	if step == nil || step.Workpaper == "" {
		if b.preset.Evidence != nil {
			name, content := b.preset.Evidence(d, skill)
			return name, content, nil
		}
		name, content := evidence(d, skill)
		return name, content, nil
	}
	entry := step.Entry
	if rework {
		entry = or(step.Fix, "Fixed what review asked for.")
	}
	name := path.Base(step.Workpaper)
	if len(d.Workspaces) > 0 {
		content, err := appendWorkpaper(ctx, d.Workspaces[0].Path, step.Workpaper, d.Task.Key, b.m.Name, entry)
		if err == nil {
			b.say("wrote", d.Task.Key, "%q to %s in %s", entry, step.Workpaper, d.Workspaces[0].Name)
			return name, content, nil
		}
		if !errors.Is(err, errNoCheckout) {
			return "", "", err
		}
	}
	return name, fmt.Sprintf("%s\n\n%s\n", d.Task.Title, entry), nil
}

// evidence is the file a builder attaches to d's Task, which needs skill, in the software preset.
func evidence(d *client.TaskDetail, skill string) (string, string) {
	switch skill {
	case SkillQA:
		return "qa-report.txt", fmt.Sprintf("%s\n\n12 checks passed, 0 failed.\n", d.Task.Title)
	case SkillDocs:
		return "draft.md", fmt.Sprintf("# %s\n\nA first draft, for review.\n", d.Task.Title)
	}
	return "build.log", fmt.Sprintf("%s\n\n$ go test ./...\nok  \tacme/app\t0.412s\n", d.Task.Title)
}
