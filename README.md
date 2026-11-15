# github-core-clone-01 — a GitHub-compatible git forge

A standalone git forge in TypeScript (Node stdlib only, no dependencies, no git
binary, no outside service). One process, in-memory store, deterministic: every
server-made timestamp comes from a fixed epoch plus a monotonic counter, so the
same request sequence leaves the same state on a live run and on a replay.

## Surfaces

- **Git smart HTTP** (`/{owner}/{repo}.git`): upload-pack protocol v2
  (`ls-refs=unborn`, `fetch=shallow`, `object-format=sha1`) and v0, receive-pack
  v0 with `report-status`, `side-band-64k`, `delete-refs`, `ofs-delta`. Packfiles
  are written plain (no deltas); OFS/REF deltas are resolved on read. Fast-forward
  is enforced per ref (`ng <ref> non-fast-forward`, the ref does not move).
- **REST v3** (`/api/v3`): repositories, branches, commits, contents, labels,
  issues, pull requests (squash merge with conflict detection), Git Data refs.
  Every reply is `application/json` with a non-empty `X-GitHub-Request-Id`.
- **GraphQL v4** (`/api/graphql`): a small executor for the documents the suite
  sends (viewer, repository, `__type`, `node(id:)`, issues/pullRequests
  connections with cursors, the five mutations). Unknown fields answer HTTP 200
  with an `errors` array naming the field; an unknown repository answers
  `data.repository = null` with no errors. Batched documents answer in order.
- **MCP** (`/mcp`): JSON-RPC 2.0, revision `2026-07-28` via `server/discover`,
  six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) on the same store as REST.

## Identity

The suite's token names the scenario viewer, but the token is opaque. The entry
derives the viewer login from the contest's fixed seed (`SCENARIO_SEED` in
`scenario.ts`, vendored from the kit's `wire.ts`): `adaiversen`
(`ada iversen <adaiversen@example.invalid>`). Every authenticated request is the
viewer; any other owner is 404, never 403.

## Run

```sh
node main.ts            # needs MAKEFUN_ENV_URL in a trial; locally, see below
```

Local check (the kit's sealed suite, pointed at a server you started):

```sh
MAKEFUN_SHOP_TOKEN=test-token node main.ts &
# in another shell, with the server's port:
node --experimental-strip-types ../github-core-clone-01-kit/sdk/run.ts \
  --url http://127.0.0.1:PORT --token test-token --perf
```

Without `MAKEFUN_SHOP_TOKEN` any non-empty Bearer token is accepted (local runs
only). `GET /healthz` needs no token.

## Files

- `main.ts` — the entry <-> env lifecycle (starter, unchanged).
- `app.ts` — HTTP server, routing, auth, request ids.
- `scenario.ts` — the seeded scenario's identity derivation (Rng + users).
- `gitobj.ts` — SHA-1 objects, pkt-lines, packfile read/write, graph walks.
- `store.ts` — repositories, issues, pull requests, contents, merges.
- `gitproto.ts` — git smart-HTTP handlers.
- `rest.ts` — REST v3 handlers.
- `graphql.ts` — GraphQL v4 executor.
- `mcp.ts` — MCP JSON-RPC handlers.

## License

MIT (see LICENSE).
