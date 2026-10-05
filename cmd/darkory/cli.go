package main

import (
	"context"
	"errors"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/tuongaz/darkory/internal/cli"
)

// runCLI runs a CLI command (internal/cli), ending with the signal that stops the process.
func runCLI(args []string, stdout, stderr io.Writer) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	env := cli.OSEnv()
	env.Stdout, env.Stderr = stdout, stderr
	return cli.Run(ctx, args, env)
}

// exitCode is the status the process ends with for err, which run returned.
func exitCode(err error) int {
	var ex *cli.ExitError
	if errors.As(err, &ex) {
		return ex.Code
	}
	return cli.ExitFailed
}
