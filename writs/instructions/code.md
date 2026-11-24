# Code

Context for every agent reading this: this file holds the operator's standing rules for code, always in force.

Never export a name by default. Export a name only when a caller outside the package needs it. Dropping a boundary
without that need makes code worse. In-package tests reach unexported names fine, so "tests might want it" is not a
need. Keep a name unexported until a real caller forces it.
