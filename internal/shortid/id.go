package shortid

// ID is an id as the server's API types carry it: it holds the canonical text storage keeps,
// writes itself in short form (in JSON, in a parameter, and when printed), and reads either form.
// Text that is not an id, such as an id a client chose for its Session that is not a UUID,
// passes through unchanged both ways.
type ID string

// Of is s as an ID.
func Of(s string) ID { return ID(Canonical(s)) }

// OfPtr is *s as an ID, or nil.
func OfPtr(s *string) *ID {
	if s == nil {
		return nil
	}
	id := Of(*s)
	return &id
}

// OfAll is each of ss as an ID.
func OfAll(ss []string) []ID {
	if ss == nil {
		return nil
	}
	out := make([]ID, len(ss))
	for i, s := range ss {
		out[i] = Of(s)
	}
	return out
}

// String is the short form.
func (id ID) String() string { return Short(string(id)) }

// Canonical is the canonical text storage keeps.
func (id ID) Canonical() string { return string(id) }

// MarshalText writes the short form; encoding/json uses it for values and map keys.
func (id ID) MarshalText() ([]byte, error) { return []byte(Short(string(id))), nil }

// UnmarshalText reads either form.
func (id *ID) UnmarshalText(b []byte) error {
	*id = ID(Canonical(string(b)))
	return nil
}

// Bind reads a path or query parameter in either form (oapi-codegen's runtime.Binder).
func (id *ID) Bind(s string) error {
	*id = ID(Canonical(s))
	return nil
}

// Strings is the canonical text of each id.
func Strings(ids []ID) []string {
	if ids == nil {
		return nil
	}
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = string(id)
	}
	return out
}

// StringPtr is the canonical text of *id, or nil.
func StringPtr(id *ID) *string {
	if id == nil {
		return nil
	}
	s := string(*id)
	return &s
}
