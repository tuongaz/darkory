package cli

import (
	"fmt"

	"github.com/tuongaz/darkory/internal/cli/remote"
)

// cmdPrime prints `export DARKORY_SESSION=<fresh id>` on its first line, so that
// `eval "$(darkory prime)"` starts a Session, and the working rules after it as shell comments
// (ADR 0005). It asks the Install nothing.
func cmdPrime(c *call) error {
	rulesOnly := c.fs.Bool("rules-only", false, "print only the working rules")
	if _, err := c.args(0, 0); err != nil {
		return err
	}
	if *rulesOnly {
		return remote.WriteRules(c.env.Stdout, "")
	}
	fmt.Fprintf(c.env.Stdout, "export %s=%s\n", remote.EnvSession, remote.NewSessionID())
	return remote.WriteRules(c.env.Stdout, "# ")
}
