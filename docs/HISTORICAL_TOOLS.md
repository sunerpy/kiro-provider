# Historical tool calls and current authorization

Responses history and the current callable tool set have separate responsibilities.
A completed ordinary function call can remain in `input` after its declaration is
removed from `tools`, including when `tools` is empty or `tool_choice` is `none`.
Its original name, arguments and result remain part of history.

The Provider still validates duplicate call IDs, orphan/repeated results, ordering,
call/result kinds, valid JSON, and the existing encrypted replay bindings (tenant,
model, account, conversation and output fingerprint). A changed current schema is
used for new output calls; historical arguments are not reinterpreted against it.

New calls are permitted only by current declarations. An identity present solely
in history cannot restore or authorize an output call. The existing output
validator and `tool_choice: none` checks remain in place for JSON and SSE.

## Namespace and custom identities

Stateless continuation records now save private identity/alias bindings in the
existing V3 envelope. A `previous_response_id` continuation restores those bindings
without copying the historical declarations into the current callable set. Tool
removal and declaration reordering do not reassign saved aliases; collisions fail.

An older or standalone namespace/custom history may lack the original mapping:
sequential aliases cannot be recovered reliably from public names alone when the
current declaration is absent. Such requests return
`400 missing_historical_tool_binding`, identifying the historical item, rather
than guessing an alias, inventing a schema or re-enabling the retired tool.
Use an existing stored continuation that contains the mapping, or explicitly
rebuild context. A tool declaration must never be reintroduced merely to bypass
this error when execution is supposed to be disabled.

There is no database DDL or configuration switch. Unknown legacy information is
not fabricated. Native capability gates, reasoning TTL, model/effort selection,
storage and timeout defaults are unchanged. Legacy Chat/Messages declaration
policy is outside this Responses change.

The same anonymous Claude Opus 5/max sealed session was verified against real Kiro
with no current tools, only an unrelated tool, and a changed same-name schema.
Stored namespace/custom continuations were also verified with current tools
removed. These observations do not assert native CreateResponse authorization or
capability for untested model/region combinations.
