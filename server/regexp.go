package server

import (
	"database/sql/driver"
	"regexp"
	"sync"

	"modernc.org/sqlite"
)

// SQLite has LIKE, not regular expressions. One place needs a real one: the
// title filter ("matches /…/"), where a word search is often too blunt — "bugs
// from #1[0-9]{2}\b", "draft|todo".
//
// Registered once, before any connection opens, and compiled patterns are
// cached: a filter runs per row, and compiling per row would make a regex
// filter cost more than the scan it saves. An invalid pattern matches nothing
// AND is treated as "no condition" by the caller (see rowFilter.where), so the
// table never blanks out mid-typing.
func init() {
	sqlite.MustRegisterScalarFunction("regexp", 2, func(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
		pat, _ := args[0].(string)
		val, _ := args[1].(string)
		re := compileRegexp(pat)
		if re == nil {
			return int64(0), nil
		}
		if re.MatchString(val) {
			return int64(1), nil
		}
		return int64(0), nil
	})
}

var (
	regexpMu    sync.Mutex
	regexpCache = map[string]*regexp.Regexp{}
)

// compileRegexp returns nil for a pattern that does not compile. The pattern
// carries its own flags ("(?i)" for a case-insensitive question), so the cache
// key is the pattern as written. The cache is small and bounded: a person types
// a handful of patterns, not thousands.
func compileRegexp(pat string) *regexp.Regexp {
	if pat == "" {
		return nil
	}
	regexpMu.Lock()
	if re, ok := regexpCache[pat]; ok {
		regexpMu.Unlock()
		return re
	}
	regexpMu.Unlock()
	re, err := regexp.Compile(pat)
	if err != nil {
		return nil
	}
	regexpMu.Lock()
	if len(regexpCache) > 64 {
		regexpCache = map[string]*regexp.Regexp{}
	}
	regexpCache[pat] = re
	regexpMu.Unlock()
	return re
}
