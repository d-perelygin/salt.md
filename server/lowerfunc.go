package server

import (
	"database/sql/driver"
	"strings"

	"modernc.org/sqlite"
)

// SQLite's own LOWER() folds ASCII only: "АвШк" came back unchanged, so a
// case-insensitive search answered no for every Cyrillic word while the
// browser, whose toLowerCase is Unicode-aware, found it. One definition here
// so the database and the interface mean the same thing by "ignore case".
//
// Registered once, before any connection opens.
func init() {
	sqlite.MustRegisterScalarFunction("lower_u", 1, func(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
		s, _ := args[0].(string)
		return strings.ToLower(s), nil
	})
}
