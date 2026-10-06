package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"

	"github.com/tuongaz/darkory/client"
)

// Statuses: where a Task is in its workflow, from the Organisation's one list (ADR 0012).

func cmdStatus(c *call) error {
	args, err := c.args(2, 2)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.SetTaskStatusWithResponse(c.ctx, args[0], &client.SetTaskStatusParams{}, client.SetTaskStatusBody{Status: args[1]})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.done(w, "Moved", *res.JSON200) })
}

func cmdWorkflow(c *call) error {
	if _, err := c.args(0, 0); err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.ListStatusesWithResponse(c.ctx)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { printStatuses(w, res.JSON200.Items) })
}

func printStatuses(w io.Writer, ss []client.Status) {
	for _, s := range ss {
		fmt.Fprintf(w, "%-3d %-20s %-12s %s\n", s.Position, one(s.Name), one(string(s.Kind)), one(s.ID))
	}
}

func cmdWorkflowSet(c *call) error {
	file := c.fs.String("file", "", "the list as JSON, {\"items\": [{\"id\", \"name\", \"kind\"}…], \"moves\": {deleted id: kept id}}; - reads standard input")
	if _, err := c.args(0, 0); err != nil {
		return err
	}
	if *file == "" {
		return usagef("needs --file")
	}
	var text []byte
	var err error
	if *file == "-" {
		text, err = io.ReadAll(c.env.Stdin)
	} else {
		text, err = os.ReadFile(*file)
	}
	if err != nil {
		return err
	}
	// `darkory workflow --json` prints a list this reads back: each Status's position is ignored,
	// since the order of items is the order.
	var body client.SetStatusesBody
	if err := json.Unmarshal(text, &body); err != nil {
		return usagef("--file is not a list of Statuses: %v", err)
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.SetStatusesWithResponse(c.ctx, &client.SetStatusesParams{}, body)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { printStatuses(w, res.JSON200.Items) })
}

// status returns a Status's name for human output, "-" when the Task carries none, or the id
// when it cannot be found.
func (c *call) status(id string) string {
	if id == "" {
		return "-"
	}
	if c.statuses == nil {
		c.statuses = map[string]string{}
		res, err := c.conn.ListStatusesWithResponse(c.ctx)
		if check(res, err, http.StatusOK) == nil {
			for _, s := range res.JSON200.Items {
				c.statuses[s.ID] = s.Name
			}
		}
	}
	if n, ok := c.statuses[id]; ok {
		return one(n)
	}
	return one(id)
}
