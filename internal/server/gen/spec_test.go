package gen_test

import (
	"net/http"
	"slices"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
)

// Operations that need no credential (plan invariant 8).
var public = []string{"getHealth", "showLoginLink", "redeemLoginLink", "requestEmailSignIn"}

// The spec is valid OpenAPI 3.0, and every operation keeps the contract's conventions, so a new
// operation cannot forget them.
func TestSpecKeepsTheConventions(t *testing.T) {
	loader := openapi3.NewLoader()
	doc, err := loader.LoadFromFile("../../../api/openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if err := doc.Validate(t.Context()); err != nil {
		t.Fatalf("invalid spec: %v", err)
	}

	ids := map[string]bool{}
	for path, item := range doc.Paths.Map() {
		for method, op := range item.Operations() {
			name := method + " " + path
			if op.OperationID == "" {
				t.Errorf("%s has no operationId", name)
				continue
			}
			ids[op.OperationID] = true

			if method != http.MethodGet && !hasParam(op, "header", "Idempotency-Key") {
				t.Errorf("%s (%s) does not accept Idempotency-Key", name, op.OperationID)
			}

			isPublic := slices.Contains(public, op.OperationID)
			switch {
			case isPublic && (op.Security == nil || len(*op.Security) != 0):
				t.Errorf("%s needs no credential, so it must say security: []", op.OperationID)
			case !isPublic && op.Security != nil:
				t.Errorf("%s overrides the credential requirement", op.OperationID)
			}

			def := op.Responses.Default()
			if def == nil || def.Ref != "#/components/responses/Error" {
				t.Errorf("%s has no default Error response", op.OperationID)
			}
		}
	}
	for _, id := range public {
		if !ids[id] {
			t.Errorf("public operation %s is missing", id)
		}
	}

	// Every authenticated request carries a bearer token with a Session, or the browser cookie.
	want := openapi3.SecurityRequirements{
		{"bearerAuth": {}, "sessionHeader": {}},
		{"cookieAuth": {}},
	}
	if len(doc.Security) != len(want) {
		t.Fatalf("top-level security %v, want %v", doc.Security, want)
	}
	for i := range want {
		if len(doc.Security[i]) != len(want[i]) {
			t.Fatalf("top-level security %v, want %v", doc.Security, want)
		}
		for k := range want[i] {
			if _, ok := doc.Security[i][k]; !ok {
				t.Fatalf("top-level security %v, want %v", doc.Security, want)
			}
		}
	}
}

func hasParam(op *openapi3.Operation, in, name string) bool {
	for _, p := range op.Parameters {
		if p.Value != nil && p.Value.In == in && p.Value.Name == name {
			return true
		}
	}
	return false
}
