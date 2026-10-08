package bot

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"path"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/tuongaz/darkory/client"
)

// Builder takes work through next and works it as the rules say: it heartbeats in the background,
// writes a Note, attaches a small Evidence file, and, when the Task asks a question of someone,
// files that question aimed at them, blocking its own Task, and waits for the answer holding its
// Claim. Then it records an Observation (didn't work when the Skill left it asking, worked
// otherwise) and advances the Task along its Step's way on: a build to review, a QA into Done. It
// reports its model label on every Claim.
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

// A Task's description asks a worker a question with a line such as this.
var questionRe = regexp.MustCompile(`(?m)^Question for (\S+): (.+)$`)

func questionLine(who, q string) string { return "Question for " + who + ": " + q }

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
		return true, on(d.Task.Key, b.work(ctx, d, true))
	})
}

// work works d's Task, which the agent has just claimed, as its Item says: a Note, the Evidence,
// a question when it asks one, then, at a Step that reviews, a hand-back along "needs changes"
// the first time; otherwise an Observation when observe says so, and the Task advanced along its
// Step's way on, or completed where that is the Step's one way, into Done, and the agent is a
// person.
func (a *agent) work(ctx context.Context, d *client.TaskDetail, observe bool) error {
	key := d.Task.Key
	wctx, stop := a.hold(ctx, d)
	defer stop()
	skill := ""
	if d.Task.SkillID != nil {
		s, err := a.skill(wctx, *d.Task.SkillID)
		if err != nil {
			return gone(wctx, err)
		}
		skill = s.Skill.Name
	}
	step := where(d)
	// What the Task asks of its worker: its plan's Item says, or else lines of its description.
	item := a.item(d)
	var who, question string
	if m := questionRe.FindStringSubmatch(d.Task.Description); m != nil {
		who, question = m[1], m[2]
	}
	outcome, handBack, rework := "", "", false
	if item != nil {
		if q := item.Question; q != nil && (q.Step == "" || q.Step == step) {
			who, question = or(q.AimedAt, a.ask), q.Title
		}
		outcome = item.Outcome
		// A reviewing Step hands the Task back the first time; the Step it goes back to fixes it.
		if item.HandBack != "" {
			sent := hasNote(d, item.HandBack)
			switch {
			case back(d) != "" && !sent:
				handBack = item.HandBack
			case sent && !hasNote(d, item.Fix) && back(d) == "":
				rework = true
			}
		}
	}

	total := a.busy()
	if !sleep(wctx, total/3) {
		return nil
	}
	note := ""
	switch {
	case handBack != "":
		note = fmt.Sprintf("Reviewing %q.", d.Task.Title)
	case item == nil || item.Workpaper == "":
		note = fmt.Sprintf("Starting on %q.", d.Task.Title)
		if first, _, _ := strings.Cut(d.Task.Description, "\n"); strings.TrimSpace(first) != "" {
			note = fmt.Sprintf("Starting on %q: %s.", d.Task.Title, strings.TrimSuffix(strings.TrimSpace(first), "."))
		}
	case rework:
		note = fmt.Sprintf("Back from review, fixing %s.", item.Workpaper)
	default:
		note = fmt.Sprintf("Working %s at %s, in %s.", d.Task.Title, step, item.Workpaper)
	}
	if err := a.note(wctx, key, note); err != nil {
		return gone(wctx, err)
	}
	if !sleep(wctx, total/3) {
		return nil
	}
	name := ""
	if handBack == "" {
		var content string
		var err error
		name, content, err = a.evidence(wctx, d, item, skill, step, rework)
		if err != nil {
			return gone(wctx, err)
		}
		if err := a.attach(wctx, key, name, content); err != nil {
			return gone(wctx, err)
		}
	}

	// A question asked once, by whoever held the Task, is not asked again.
	asked := rework
	for _, bl := range d.Blockers {
		asked = asked || bl.AimedAtID != nil
	}
	if question != "" && !asked && handBack == "" {
		asked = true
		answered, err := a.askAndWait(wctx, d, who, question)
		if err != nil || wctx.Err() != nil {
			return gone(wctx, err) // the Claim was lost while waiting, or the bot is stopping
		}
		if !answered {
			stop()
			if ctx.Err() != nil {
				return nil
			}
			return gone(ctx, a.release(ctx, key, fmt.Sprintf("Waiting for %s to answer; whoever takes it next can carry on once they have.", who)))
		}
	}
	if !sleep(wctx, total/3) {
		return nil
	}

	if handBack != "" {
		stop()
		if ctx.Err() != nil {
			return nil
		}
		if _, err := a.advance(ctx, key, back(d), handBack); err != nil {
			return gone(ctx, err)
		}
		a.say("handed back", key, "%q", handBack)
		return nil
	}
	if observe {
		outcome, body := client.Worked, fmt.Sprintf("%s went as %s describes.", d.Task.Title, or(skill, "the Skill"))
		if question != "" && asked && !rework {
			outcome, body = client.DidntWork, fmt.Sprintf("%s did not answer this, so %s had to: %s", or(skill, "The Skill"), who, question)
		}
		res, err := a.c.ObserveWithResponse(wctx, key, &client.ObserveParams{}, client.ObserveBody{Outcome: outcome, Body: body})
		if err := check(res, err, http.StatusCreated); err != nil {
			return gone(wctx, err)
		}
		a.say("observed", key, "%s: %q", outcome, body)
	}
	stop()
	if ctx.Err() != nil {
		return nil
	}
	done := "Done; " + name + " is attached."
	if item != nil && item.entry(step) != "" {
		done = item.entry(step)
	}
	if rework {
		done = or(item.Fix, "Fixed what review asked for.")
	}
	// A person completes a Task whose Step has one way out, into Done; an agent always advances.
	if !observe && len(d.Connectors) == 1 && d.Connectors[0].ToStepID == nil {
		_, err := a.complete(ctx, key, done)
		return gone(ctx, err)
	}
	_, err := a.advance(ctx, key, onward(d, outcome), done)
	return gone(ctx, err)
}

// hasNote says whether one of d's Notes says text.
func hasNote(d *client.TaskDetail, text string) bool {
	return text != "" && slices.ContainsFunc(d.Notes, func(n client.Note) bool { return n.Body == text })
}

// askAndWait files a question aimed at who that blocks d's Task, then waits, holding the Claim,
// until the Task is unblocked or Patience runs out. It says whether the question was answered.
func (b *agent) askAndWait(wctx context.Context, d *client.TaskDetail, who, q string) (bool, error) {
	desc := fmt.Sprintf("%s asks while working %s %q.", b.m.Name, d.Task.Key, d.Task.Title)
	res, err := b.c.FileTaskWithResponse(wctx, &client.FileTaskParams{}, client.FileTaskBody{
		Title: q, Aim: &who, Blocks: &d.Task.Key, Description: &desc})
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

// evidence is the file a worker attaches to d's Task: the workpaper its Item names, with the
// Item's line for the Step (or, on rework, its fix) appended, from the Task's first Workspace on
// this machine; the line alone when there is no Workspace or it is elsewhere; else the preset's
// file for the Skill.
func (b *agent) evidence(ctx context.Context, d *client.TaskDetail, item *Item, skill, step string, rework bool) (string, string, error) {
	if item == nil || item.Workpaper == "" {
		if b.preset.Evidence != nil {
			name, content := b.preset.Evidence(d, skill)
			return name, content, nil
		}
		name, content := evidence(d, skill)
		return name, content, nil
	}
	entry := item.entry(step)
	if rework {
		entry = or(item.Fix, "Fixed what review asked for.")
	}
	name := path.Base(item.Workpaper)
	if len(d.Workspaces) > 0 {
		content, err := appendWorkpaper(ctx, d.Workspaces[0].Path, item.Workpaper, d.Task.Key, b.m.Name, entry)
		if err == nil {
			b.say("wrote", d.Task.Key, "%q to %s in %s", entry, item.Workpaper, d.Workspaces[0].Name)
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
