package gen_test

import (
	"net/http"
	"slices"
	"strings"
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

// refs are the properties named as ids that take a reference (an id, or a name or key), which the
// core resolves; they stay plain strings. Every other id is `format: id` (ADR 0017).
var refs = map[string]bool{"FileTaskBody.labels": true, "SetTaskLabelsBody.labels": true}

// Every id the spec carries says `format: id`, so the server writes it short and reads either
// form: a property named id, *_id or *_ids, or one of the few named otherwise.
func TestIDsSayFormatID(t *testing.T) {
	doc, err := openapi3.NewLoader().LoadFromFile("../../../api/openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	otherNames := map[string]bool{"labels": true, "filed_by": true, "published_by": true, "attached_by": true, "created_by": true}
	ids := 0
	for name, s := range doc.Components.Schemas {
		for prop, ps := range s.Value.Properties {
			if !(prop == "id" || strings.HasSuffix(prop, "_id") || strings.HasSuffix(prop, "_ids") || otherNames[prop]) || refs[name+"."+prop] {
				continue
			}
			v := ps.Value
			if v.Type.Is("array") {
				if v.Items.Ref != "" {
					continue // a list of records, such as TaskDetail.labels
				}
				v = v.Items.Value
			}
			if v.Format != "id" {
				t.Errorf("%s.%s is an id without format: id", name, prop)
			}
			ids++
		}
	}
	if ids < 60 {
		t.Errorf("only %d ids found; the walk is broken", ids)
	}
	if p := doc.Components.Schemas["ID"].Value; p.Format != "id" || p.Pattern == "" {
		t.Errorf("the ID schema defines format id with its pattern")
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
