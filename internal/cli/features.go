package cli

import (
	"fmt"
	"io"
	"net/http"
	"strconv"

	"github.com/tuongaz/darkory/client"
)

var featureCommands = []command{
	{path: "feature create", args: "--team t --title t [--body text|-] [--owner m] [--from-retro task] [--ship-when-done] [--quick --skill s [--workspace ws]…]", short: "file a Feature, with its Break down Task, or a quick one with its one Task", run: cmdFeatureCreate},
	{path: "feature list", args: "[--team t] [--state s] [--owner m] [--filter field:op:values]...", short: "list Features by Team and Rank", run: cmdFeatureList},
	{path: "feature show", args: "<feature>", short: "show a Feature with its Tasks and Evidence", run: cmdFeatureShow},
	{path: "feature rank", args: "<feature> <position>", short: "move a Feature in its Team's Rank (1 is first)", run: cmdFeatureRank},
	{path: "feature ship", args: "<feature>", short: "ship a Feature whose Tasks have all ended (owner)", run: cmdFeatureShip},
	{path: "feature drop", args: "<feature>", short: "drop a Feature and its open Tasks (owner)", run: cmdFeatureDrop},
	{path: "feature owner", args: "<feature> <member>", short: "pass a Feature's ownership", run: cmdFeatureOwner},
	{path: "feature observations", args: "<feature> [--all]", short: "list the Observations on a Feature's Tasks not yet reviewed", run: cmdFeatureObservations},
}

func cmdFeatureCreate(c *call) error {
	team := c.fs.String("team", "", "the Team the Feature belongs to")
	title := c.fs.String("title", "", "the Feature's title")
	body := c.fs.String("body", "", "the Feature's description (- reads standard input)")
	owner := c.fs.String("owner", "", "the Feature owner (default: you)")
	retro := c.fs.String("from-retro", "", "the Retrospective Task filing this Feature")
	quick := c.fs.Bool("quick", false, "file a quick Feature: its one Task needing --skill, instead of a Break down; it ships when done")
	skill := c.fs.String("skill", "", "the Skill a quick Feature's Task needs")
	var workspaces strs
	c.fs.Var(&workspaces, "workspace", "a Workspace a quick Feature's Task names; give it once per Workspace (default: the Team's)")
	var ship optBool
	c.fs.Var(&ship, "ship-when-done", "ship the Feature when its last Task is completed (default: the Team's; always for --quick)")
	if _, err := c.args(0, 0); err != nil {
		return err
	}
	if *team == "" || *title == "" {
		return usagef("needs --team and --title")
	}
	if *quick != (*skill != "") {
		return usagef("--quick and --skill go together: a quick Feature's one Task needs a Skill")
	}
	desc, err := c.optText(*body)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	req := client.FileFeatureBody{Team: *team, Title: *title, Description: desc, Owner: opt(*owner), FromRetrospective: opt(*retro),
		Skill: opt(*skill), ShipWhenDone: ship.v}
	if *quick {
		req.Quick = quick
	}
	if workspaces.set {
		req.Workspaces = &workspaces.v
	}
	res, err := conn.FileFeatureWithResponse(c.ctx, &client.FileFeatureParams{}, req)
	if err := check(res, err, http.StatusCreated); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printFeatureDetail(w, *res.JSON201) })
}

func cmdFeatureList(c *call) error {
	team := c.fs.String("team", "", "only this Team's Features")
	state := c.fs.String("state", "", "only Features in this state: open, shipped or dropped")
	owner := c.fs.String("owner", "", "only Features this Member owns")
	var filters strs
	c.fs.Var(&filters, "filter", "only Features matching field:op:values, such as quick:is:true (ids, not names); give it once per filter")
	limit := c.fs.Int("limit", 0, "at most this many Features (default 100)")
	cursor := c.fs.String("cursor", "", "the next page, from a previous list")
	if _, err := c.args(0, 0); err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	params := &client.ListFeaturesParams{Team: opt(*team), Owner: opt(*owner), Cursor: opt(*cursor)}
	if filters.set {
		params.Filter = &filters.v
	}
	if *state != "" {
		params.State = ptr(client.FeatureState(*state))
	}
	if *limit > 0 {
		params.Limit = limit
	}
	res, err := conn.ListFeaturesWithResponse(c.ctx, params)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) {
		if len(res.JSON200.Items) == 0 {
			fmt.Fprintln(w, "No Features.")
		}
		for _, f := range res.JSON200.Items {
			c.printFeatureLine(w, f)
		}
		if res.JSON200.NextCursor != nil {
			fmt.Fprintf(w, "More: --cursor %s\n", *res.JSON200.NextCursor)
		}
	})
}

func cmdFeatureShow(c *call) error {
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.GetFeatureWithResponse(c.ctx, args[0])
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printFeatureDetail(w, *res.JSON200) })
}

func cmdFeatureRank(c *call) error {
	args, err := c.args(2, 2)
	if err != nil {
		return err
	}
	pos, err := strconv.ParseInt(args[1], 10, 64)
	if err != nil || pos < 1 {
		return usagef("the position is a number from 1")
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.RankFeatureWithResponse(c.ctx, args[0], &client.RankFeatureParams{}, client.RankFeatureBody{Position: pos})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printFeatureLine(w, *res.JSON200) })
}

func cmdFeatureShip(c *call) error {
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.ShipFeatureWithResponse(c.ctx, args[0], &client.ShipFeatureParams{})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printFeatureDetail(w, *res.JSON200) })
}

func cmdFeatureDrop(c *call) error {
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.DropFeatureWithResponse(c.ctx, args[0], &client.DropFeatureParams{})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printFeatureDetail(w, *res.JSON200) })
}

func cmdFeatureOwner(c *call) error {
	args, err := c.args(2, 2)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.PassFeatureOwnershipWithResponse(c.ctx, args[0], &client.PassFeatureOwnershipParams{},
		client.PassFeatureOwnershipBody{Owner: args[1]})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printFeatureLine(w, *res.JSON200) })
}

func cmdFeatureObservations(c *call) error {
	all := c.fs.Bool("all", false, "every Observation, reviewed by a Retrospective or not")
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	// The contract's reviewed=true means every Observation; leaving it out, only unreviewed ones.
	params := &client.ListFeatureObservationsParams{}
	if *all {
		params.Reviewed = ptr(true)
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.ListFeatureObservationsWithResponse(c.ctx, args[0], params)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) {
		if len(res.JSON200.Items) == 0 {
			fmt.Fprintln(w, "No Observations.")
		}
		for _, o := range res.JSON200.Items {
			c.printObservation(w, o)
		}
	})
}
