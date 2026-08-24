# TFS Ripast template subset

Python/Jinja is a bounded plan compiler, not a general program runtime. It
renders one JSON RewritePlan in memory and never reads or writes target source
files. The TypeScript CLI validates the concrete plan again and retains all
preview, approval, and write authority.

Supported templates may use:

- JSON literals and values from the JSON data object;
- `if` and non-recursive `for` blocks;
- loops whose iterable directly names or indexes JSON data;
- loop metadata such as `loop.index`, `loop.first`, and `loop.last`;
- boolean truthiness conditions and conditional expressions; and
- `tojson`, `lower`, `upper`, `replace`, `join`, `length`, `sort`, and
  `dictsort` filters.

The compiler rejects function and macro calls, imports/includes, attribute
access outside the fixed loop metadata, recursive loops, computed or filtered
loop iterables, assignments, comparisons and membership, slicing,
concatenation, and arithmetic operators including string/list multiplication.
Default globals and tests are unavailable. Collection access and every exposed
filter consume the shared execution budget.

Default resource limits are 256 KiB of template UTF-8, 1 MiB of JSON data,
1 MiB of rendered JSON, 4,096 template AST nodes, and 100,000 deterministic
execution units. Input files are read only up to their limits. Collection
iterations and filter work consume the shared execution budget, including
outputless nested loops. Amplifying filters preflight their result before
allocation. Public overrides remain below fixed hard ceilings of 1 MiB for a
template, 8 MiB each for data and rendered JSON, and 1,000,000 execution units.
