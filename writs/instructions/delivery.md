# Path Delivery Mechanics

Context: this file carries the mechanical rules for how paths and generated files reach the operator. The prose rules
live in writing.md; this file is wire format, not style.

A path the operator is meant to open goes out as the full absolute path: no `~`, no backticks around it, and no
punctuation directly after it. The operator clicks it, and the terminal does not link a path with a period stuck to its
end.

Give the files you generate hyphenated names, not underscores: a renderer reads `_8133_` as italics and drops the
underscores, so the link points at a file that does not exist.
