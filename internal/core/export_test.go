package core

// The guards a held write's batch ends with, for the tests that run them against a Workflow
// edited after the read; a race between a read and its batch cannot be interposed from outside.
var (
	StepGuard = stepGuard
	FromGuard = fromGuard
)
