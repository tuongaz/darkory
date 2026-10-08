package runner

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/tuongaz/darkory/internal/shortid"
)

// Progress is how the runner tells a session is working (ADR 0013): the modified time of a file
// the agent writes as it goes, and its last record, which says whether the agent's turn ended.
// For Claude Code the file is its transcript; another command names its own in its settings.

// TurnEnded is the line a generic progress file writes when the agent stops and waits for input,
// as Claude Code's transcript does with an assistant message that asks for no tool.
const TurnEnded = "TURN_ENDED"

// ProjectSlug is the directory name Claude Code keeps a working directory's transcripts under in
// ~/.claude/projects: the path with every character but a letter or digit replaced by '-'.
func ProjectSlug(cwd string) string {
	b := []byte(cwd)
	for i, c := range b {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9') {
			b[i] = '-'
		}
	}
	return string(b)
}

// ClaudeDir is where Claude Code keeps its state in a session whose environment is env:
// CLAUDE_CONFIG_DIR when set, else ~/.claude.
func ClaudeDir(env []string) string {
	if d, _ := lookupEnv(env, "CLAUDE_CONFIG_DIR"); d != "" {
		return d
	}
	home, _ := lookupEnv(env, "HOME")
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	return filepath.Join(home, ".claude")
}

// TranscriptPath is where Claude Code writes the transcript of session id started in cwd. The
// working directory is resolved first, since Claude Code names the project after the real path
// (/tmp is /private/tmp on macOS).
func TranscriptPath(claudeDir, cwd, id string) string {
	if real, err := filepath.EvalSymlinks(cwd); err == nil {
		cwd = real
	}
	// Claude Code names the transcript after the session's UUID (ADR 0017).
	return filepath.Join(claudeDir, "projects", ProjectSlug(cwd), shortid.Canonical(id)+".jsonl")
}

// findTranscript looks for session id's transcript in any project, for when the slug the runner
// computed is not the one Claude Code used.
func findTranscript(claudeDir, id string) string {
	found, _ := filepath.Glob(filepath.Join(claudeDir, "projects", "*", shortid.Canonical(id)+".jsonl"))
	if len(found) == 0 {
		return ""
	}
	return found[0]
}

// Reading is what a progress file said when it was last read.
type Reading struct {
	// Exists is false until the agent writes the file.
	Exists bool
	// Modified is the file's modified time.
	Modified time.Time
	// Ended says the agent's last turn ended: it is waiting for input.
	Ended bool
	// InFlight says a tool call is running: the last record is the agent asking for a tool, with
	// no result yet. A long call writes nothing until it returns.
	InFlight bool
}

// tailBytes is how much of the end of a progress file is read for its last record.
const tailBytes = 256 << 10

// ReadProgress stats path and reads its last record.
func ReadProgress(path string) (Reading, error) {
	f, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return Reading{}, nil
	}
	if err != nil {
		return Reading{}, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return Reading{}, err
	}
	off := max(st.Size()-tailBytes, 0)
	buf := make([]byte, st.Size()-off)
	if _, err := f.ReadAt(buf, off); err != nil && !errors.Is(err, io.EOF) {
		return Reading{}, err
	}
	if off > 0 {
		// The first line read may be cut; skip it.
		if i := bytes.IndexByte(buf, '\n'); i >= 0 {
			buf = buf[i+1:]
		}
	}
	ended, inFlight := lastTurn(buf)
	return Reading{Exists: true, Modified: st.ModTime(), Ended: ended, InFlight: inFlight}, nil
}

// headBytes is how much of the start of a transcript is read for an assistant message.
const headBytes = 4 << 20

// HasAssistantMessage says whether the transcript at path holds an assistant message of the main
// conversation: whether the agent's model has answered at all. A file not there yet holds none;
// one whose first headBytes hold none, but which goes on, counts as holding one.
func HasAssistantMessage(path string) (bool, error) {
	f, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer f.Close()
	sc := bufio.NewScanner(io.LimitReader(f, headBytes))
	sc.Buffer(make([]byte, 64<<10), headBytes)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var r transcriptRecord
		if json.Unmarshal(line, &r) == nil && r.Type == "assistant" && !r.IsSidechain {
			return true, nil
		}
	}
	if sc.Err() != nil {
		return true, nil
	}
	if st, err := f.Stat(); err == nil && st.Size() > headBytes {
		return true, nil
	}
	return false, nil
}

// transcriptRecord is the part of a Claude Code transcript line the runner reads.
type transcriptRecord struct {
	Type        string `json:"type"`
	IsSidechain bool   `json:"isSidechain"`
	Message     *struct {
		Role       string          `json:"role"`
		StopReason *string         `json:"stop_reason"`
		Content    json.RawMessage `json:"content"`
	} `json:"message"`
}

// TurnHasEnded reads the end of a progress file. Its last non-empty line TURN_ENDED means the
// turn ended. Otherwise the file is read as a Claude Code transcript: the last user or assistant
// message of the main conversation decides, and the turn has ended when it is an assistant
// message that asks for no tool. Other records Claude Code appends (titles, costs, attachments,
// subagents' messages) are passed over.
func TurnHasEnded(tail []byte) bool {
	ended, _ := lastTurn(tail)
	return ended
}

// lastTurn reads the end of a progress file as TurnHasEnded does, and says too whether a tool
// call is in flight: the last message of the main conversation is an assistant message asking for
// a tool, which its result has not followed yet.
func lastTurn(tail []byte) (ended, inFlight bool) {
	lines := bytes.Split(bytes.TrimRight(tail, "\n"), []byte("\n"))
	if n := len(lines); n > 0 && strings.TrimSpace(string(lines[n-1])) == TurnEnded {
		return true, false
	}
	for i := len(lines) - 1; i >= 0; i-- {
		line := bytes.TrimSpace(lines[i])
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var r transcriptRecord
		if json.Unmarshal(line, &r) != nil || r.IsSidechain || r.Message == nil {
			continue
		}
		switch r.Type {
		case "user":
			return false, false
		case "assistant":
			var blocks []struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(r.Message.Content, &blocks) == nil {
				for _, b := range blocks {
					if b.Type == "tool_use" {
						return false, true
					}
				}
			}
			if r.Message.StopReason != nil && *r.Message.StopReason == "tool_use" {
				// Claude Code writes a turn's blocks as records of their own: thinking first, the
				// tool_use after it.
				return false, false
			}
			return true, false
		}
	}
	return false, false
}

// proc is a process running under a session.
type proc struct {
	PID     int
	Started time.Time
	Command string
}
