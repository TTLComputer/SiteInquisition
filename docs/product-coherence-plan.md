# SiteInquisition product coherence implementation plan

Date: November 6, 2026  
Audience: developers implementing the desktop UI and supporting core APIs  
Status: proposed design and implementation sequence  
Reviewed baseline: commit `6a0566f`

## Purpose and recommendation

Organize SiteInquisition around a developer's investigation: observe an application, understand its API, reproduce an interaction, change live behavior, and retain the result for later use. The next milestone should connect existing capabilities into that workflow before expanding the number of top-level tools.

The product promise is: **Understand an unfamiliar application, change how it behaves, and save a repeatable reproduction.** This covers both reverse engineering poorly documented applications and helping developers build against incomplete or unreliable backends.

This document specifies changes to navigation, workspace state, endpoint exploration, replay, overrides, authentication, and saved work. It includes the reasons for each change, implementation boundaries, migration requirements, and acceptance tests. It is a source-based design review; it does not claim that the proposed UI has been validated with users. Proposed types, files, and API names below are design sketches, not existing interfaces.

Keep the existing capture engines, codecs, scripts, protocol tools, and API discovery capabilities. Reuse them behind a clearer product model. The initial navigation work should not change network behavior or migrate captured traffic.

## Current sources of fragmentation

The application has already improved in useful ways. Replay now opens a WebSocket conversation editor when the selected exchange is a WebSocket; nested decoding can round-trip edits; shared Replay actions reduce inconsistency. Extend those patterns.

| Observed structure | Effect on the developer | Relevant source |
| --- | --- | --- |
| Fourteen peer sidebar destinations mix activities, protocols, and utilities | Users must learn the tool inventory before knowing where to work | `packages/ui/src/App.tsx`, `NAV` |
| Coverage is under History while resources, values, glossary, specifications, and tests are under API | Understanding one endpoint requires switching between unrelated screens | `views/History.tsx`, `views/Api.tsx` |
| Variables, login macros, and AWS signing are under Cookies | Important configuration is difficult to predict from the label | `views/Cookies.tsx` |
| Workspace tabs cover History and replay documents only | Flows, comparisons, codecs, and other work follow different navigation rules | `App.tsx`, `state.tsx` |
| `setView` checks unsaved changes, while several contextual helpers call `setViewState` directly | Navigation behavior depends on the entry point | `state.tsx`, `unsaved.ts` |
| Replay exposes authentication, encoding, flow, and transport settings together | Users encounter specialist configuration before they need it | `views/Replay.tsx` |
| Mocks, replacements, breakpoints, and live scripts have separate management surfaces | It is difficult to answer which modifications currently affect traffic | `views/RulesTools.tsx`, `views/Scripts.tsx` |
| Flows can generate test scripts that users then run in Scripts | A saved reproduction changes location and representation as it becomes a regression test | `views/Api.tsx`, `flowToTest` |

These are connected design problems. Relabeling the sidebar alone will improve discovery but will not solve lost context, fragmented saved work, or unclear live behavior.

## Product vocabulary and ownership

Use a small set of concepts consistently in labels, routes, APIs, and documentation.

| Concept | Meaning | Ownership |
| --- | --- | --- |
| Project | Targets, capture configuration, saved artifacts, and recorded evidence for a piece of work | Core persistence |
| Exchange | An immutable recorded request and response, or a recorded connection | Existing capture store |
| Endpoint | A stable identity grouping an operation and its observed evidence | Core discovery and metadata |
| Draft | Editable work that has not been explicitly saved as a reusable artifact | Recoverable per-user workspace |
| Reproduction | A named request, conversation, or multi-step flow with inputs and optional assertions | Core persistence |
| Run | An execution of a reproduction, with resolved context and results | Core persistence |
| Override | A configuration that modifies, pauses, drops, or substitutes live traffic | Existing rule or script record with shared presentation |
| Override group | A named set of overrides applied together | New project metadata |
| Session profile | References to authentication, cookie policy, signing, and setup behavior | Project configuration with private credential references |

An exchange is evidence, a draft is editable work, and a run is a new execution. Do not overwrite evidence when editing a draft. Keep references from derived artifacts back to their source exchanges, but do not require those exchanges to exist forever.

## Navigation architecture

### Four primary work areas

| Area | Default view | Included capabilities |
| --- | --- | --- |
| Traffic | Recorded requests with inspector | Browser, timeline, live connections, saved traffic filters |
| Explore API | Hosts and endpoint catalog | Coverage, resources, fields, values, specifications, GraphQL discovery, technology evidence |
| Replay | Open editors and saved reproductions | HTTP requests, WebSocket conversations, flows, comparisons, assertions, run history |
| Overrides | Active override list | Mocks, replacements, breakpoints, live hooks, named groups |

Project settings holds capture scope, listeners, devices, TLS trust, storage, authentication configuration, variables, and integrations. Advanced tools remains accessible from the navigation footer and command search: Race, HTTP/3 lab, standalone decoding, and script console. Preserve direct shortcuts for expert users.

Browser and Timeline become views within Traffic. Streams becomes live connections within Traffic; replaying a connection opens its protocol-appropriate editor. MQTT keeps its current supported actions rather than acquiring a misleading generic Replay button.

Coverage and Resources become complementary views of the endpoint catalog. Technology evidence moves into host and endpoint detail, with an aggregate technology view reachable from Explore API. Compare opens a workspace document from any supported selection. Auth matrix and negative tests become endpoint or reproduction actions with results retained under their runs.

### Implement without a large initial rewrite

Add a route adapter between existing `ViewId` destinations and the new work areas. Initially render existing components behind the new shell. Preserve `openAt` callers and keyboard shortcuts through the adapter, then migrate them incrementally to typed navigation actions.

Do not duplicate components to populate multiple routes. Each capability has one owning editor and can have several entry points. Old route names should resolve to the corresponding new destination for at least one compatibility cycle.

Acceptance: every current destination remains reachable; saved views still restore their queries; contextual actions open the correct subview; no rule is enabled, disabled, or reordered by navigation migration.

## Workspace and navigation state

### Separate location from open documents

Replace the History-or-replay tab model with typed workspace documents. The work area tells the user what kind of work is being shown; a document identifies a particular request, endpoint, flow, or comparison.

Suggested document kinds are `http-replay`, `ws-replay`, `flow`, `comparison`, and `endpoint`. Retain protocol-specific editor state behind a shared document interface. Do not force HTTP body state and WebSocket step state into one large optional-field object.

Maintain three separate state categories:

1. Navigation: area, route, filters, selected host, and back/forward history.
2. Documents: stable document IDs, draft contents, source references, dirty state, and selected run.
3. Live state: connection status, pending pauses, active jobs, and approvals, refreshed from the core.

Suggested implementation files are `workspace/types.ts`, `workspace/reducer.ts`, `workspace/navigation.ts`, and `workspace/persistence.ts`. Extract these responsibilities from `state.tsx` gradually. Continue using the existing core client and change notifications.

### Predictable navigation and recovery

Route every navigation entry point through one service, including keyboard actions, row menus, endpoint links, token provenance, and MCP open-in-editor actions. Switching views should retain recoverable drafts without prompting. Closing or explicitly discarding an unsaved document should offer Save, Discard, or Cancel. Application shutdown should flush recovery state and report a failed save rather than silently claiming success.

Persist a versioned per-user workspace keyed by project identity. Store document state and layout separately from shared project artifacts. Reopen drafts after restart without rerunning network requests or resuming live connections. A recovered WebSocket editor is disconnected until the user connects it.

Persisted drafts can contain sensitive traffic. Apply existing project storage and secret handling policies; do not place credentials in route strings or introduce an unprotected browser-local copy. Store references to saved credentials where possible. Distinguish automatic recovery from an explicit Save to Library action.

Acceptance: navigate from an edited request to an endpoint, decode a field, inspect its origin, and return with the draft intact. Restart and recover the draft without sending traffic. Closing one dirty document must not clear another document's dirty state. A missing source exchange must produce an understandable state, not a blank editor.

## Endpoint workspace

### Bring evidence together

The endpoint catalog should group observed and documented operations by origin, method, and path template. Selecting an endpoint opens one detail workspace with Overview, Traffic, Fields and values, Contract, and Related work views. These are proposed view labels and may be refined after interaction testing.

Overview shows observed statuses, examples, authentication evidence, errors, and notes. Fields and values combines field definitions, sample values, provenance links, and token insertion. Contract compares imported definitions with observed behavior. Related work lists reproductions and overrides attached to the endpoint.

Always distinguish observed facts, imported documentation, and inference. A path mentioned in JavaScript is a candidate endpoint, not a verified operation. Show sample counts and the relevant filter or time range so a field inferred from two requests does not appear authoritative.

### Identity and queries

Reuse `coverage.ts`, `values.ts`, `specs.ts`, and endpoint notes in `powertools.ts`. Add an aggregation API only where composing existing calls becomes slow or inconsistent. Paginate evidence requests and avoid rescanning all decoded bodies on every tab switch.

Define a stable endpoint reference before attaching saved artifacts. Include project, origin including port, method, and canonical operation identity. Treat inferred templates as revisable: if an inferred template changes, preserve aliases or an explicit mapping so notes and saved work do not become orphaned. Imported operation IDs are useful metadata but are not guaranteed unique across specifications.

GraphQL operations sharing a POST URL need an operation-level child identity. WebSocket connections should retain their connection and message views; a REST endpoint template is not an adequate substitute for a conversation model.

Acceptance: select an endpoint, inspect a field's origin, open the contributing exchange, and return to the same endpoint and filter. Changing template inference must not silently detach notes. “No observations” and “No documented operation” must be different states.

## Replay and saved reproductions

### One editing experience with protocol-specific content

Keep the recent protocol-aware Replay routing. Standardize the surrounding editor: title, source link, session summary, primary action, run navigation, comparison, and Save. HTTP uses Send; a conversation or flow uses Run. Streaming connections additionally expose their connection state and Stop or Disconnect action.

Group advanced options into Session, Setup, Encoding, and Transport. Expand sections when relevant and retain a visible summary of active settings, for example “Staging session · refresh CSRF · setup flow · HTTP/3.” Changing destinations must not silently reuse credentials from an unrelated profile.

Keep raw editing available. Add the decoded body editor as a panel within the document, using the existing codec machinery. Identify which draft and field the panel edits. Replace transient return callbacks with explicit document and selection references where recovery requires serializable state. If the draft has changed since the selection was opened, resolve the conflict instead of writing into stale offsets.

### Preserve the reproduction as it becomes a test

A saved reproduction contains a name, kind, versioned definition, input declarations, source links, session references, optional assertions, and endpoint references. Reuse existing flows and WebSocket scripts through adapters. A single request can be promoted to a flow without losing its provenance or saved identity.

Represent authentication macros as setup flows in the product UI, but keep their existing execution behavior until a tested migration exists. A flow marked for authentication should still support the current triggering behavior. Do not silently substitute retry semantics while renaming it.

Assertions belong with the reproduction and are displayed with its run results. Generated test scripts remain an export or advanced editing option. Users should not have to find a new script elsewhere just to rerun the same reproduction with checks.

A run records the definition revision, start and end time, terminal state, exchange references, assertion results, and configuration references. Use explicit states such as running, passed, failed, canceled, and interrupted. Record sensitive resolved values only under established capture policies; a shareable run should reference or redact secrets.

Acceptance: save an HTTP request, add it to a flow, add an assertion, and rerun from the same library location. Later edits must not change the definition revision associated with earlier runs. HTTP and WebSocket editors must use consistent source links, save behavior, and run navigation.

## Live overrides

### Shared presentation over existing engines

Create a combined list of mocks, replacements, breakpoints, and live hook scripts. Each row identifies kind, target, enabled state, execution phase, hit count when available, and source exchange or endpoint. Link to the existing specialized editor initially.

The global status should distinguish configured overrides, enabled overrides, and paused items. Do not label an enabled rule as having affected a request unless it actually matched. Replay sending and live modification must remain visibly distinct.

Document and display the actual pipeline order. Derive explanations from execution events rather than inventing a UI order that differs from the core. List reordering should be offered only where the corresponding engine supports it and its behavior is defined.

### Groups and suspension semantics

Add named override groups such as “Checkout payment failure.” Groups reference stable existing rule IDs instead of copying rules. Initially make a group change an atomic batch of member enabled states; preview conflicts when rules belong to multiple groups. Define this behavior explicitly before introducing scenario state machines.

Add a master suspension gate that preserves individual enabled flags. Suspension prevents new live modifications; it must not accidentally resume traffic waiting at breakpoints. Offer explicit actions for already paused items. Restoring a project must not unexpectedly turn a previously suspended session into an active modifying session.

### Explain the result

For a selected exchange, expose original client request, outgoing request, upstream response, and delivered response where available. A mock has no upstream response and should say so. Record ordered transformation metadata with rule ID, revision, outcome, and a bounded patch or before/after reference.

Do not promise complete original bodies if capture limits prevented retaining them. Display truncated, unavailable, or skipped-due-to-limit states. For WebSocket edits, reuse the existing original-message evidence rather than building a separate explanation convention.

Acceptance: create an override from an exchange, see it in the global active summary, exercise it, and inspect the exact change. Suspending and restoring overrides must preserve member configuration. An unrelated request must explain that no override matched. Group activation failures must not leave an undisclosed partially applied state.

## Session configuration and reusable values

Move cookie jar, variables, extraction, signing, and login setup into a discoverable Session and authentication section of Project settings. Offer contextual entry points from Replay and endpoint detail so common changes do not require a settings detour.

Initially this is a presentation change over existing stores. A later session profile should reference cookie policy, authentication setup flow, signing configuration, and named values. Environment base URLs can be added to the same selection experience without treating environment and user identity as identical concepts.

Specify precedence before implementing profiles: explicit run inputs override reproduction defaults, which override profile values, which override project defaults. Show the effective value and its source in the token picker. Existing flow-local variables must retain their intended isolation. Credential scope and cookie domain rules remain enforced independently of UI grouping.

Do not move private credentials into shared artifacts to simplify the model. Profile exports should carry credential references or placeholders. Switching profiles must not silently attach one user's cookies to another user's run.

Acceptance: a developer can find and edit an extracted token without guessing that Variables lives under Cookies. A replay shows its effective session and input sources before sending. Missing credentials produce an actionable error rather than fallback to an unrelated identity.

## Onboarding and contextual actions

Offer three starting paths: Open a website, Connect an external client, and Import traffic or API definitions. Guide scope and certificate setup within the selected path. Preserve the current record-nothing default until the user selects a target. Explain capture, decryption, and modification separately.

After the first captured request, present contextual actions rather than a tour of all features. Show Replay, Explore endpoint, and Create override. Creating reusable work should be a continuation of inspecting real traffic.

Add a shared action registry for labels, shortcuts, supported selections, and handlers. Use it in row menus, inspector toolbars, endpoint detail, and command search. Disable unsupported actions with a reason. Keep the current shared Replay affordance while extending consistency to Compare, Create override, Add to flow, and Trace value.

Do not silently repurpose Ctrl K from filtering traffic to a different global action. If it becomes command search, retain an obvious traffic-search mode, update shortcut help, and test the transition.

## Implementation ownership

| Workstream | Existing files to adapt | New responsibilities |
| --- | --- | --- |
| Shell and route adapter | `ui/src/App.tsx`, `ui/src/state.tsx` | Work areas, compatibility routes, document navigation |
| Workspace recovery | `ui/src/state.tsx`, `ui/src/unsaved.ts`, replay editors | Versioned draft state, per-document lifecycle, restoration |
| Endpoint detail | `views/Api.tsx`, `views/Coverage.tsx`, `views/TechOverview.tsx` | Shared endpoint context and evidence views |
| Replay consistency | `views/Replay.tsx`, `views/WsReplay.tsx`, `views/Codecs.tsx` | Shared editor chrome and contextual decoding |
| Override control | `views/Rules.tsx`, `views/RulesTools.tsx`, `views/Scripts.tsx` | Combined list, groups, effective-state summary |
| Core artifact APIs | `core/src/api.ts`, `core/src/powertools.ts`, `core/src/store.ts` | Saved definitions, revisions, relationships, change events |
| Execution adapters | `core/src/flows.ts`, `core/src/send.ts`, WebSocket execution modules | Unified run records without changed protocol semantics |
| Shared actions | `ui/src/actions.ts`, `components/ReplayButton.tsx` | Selection-aware registry and consistent labels |

Paths in this table are relative to `packages/`. Keep presentation state in the UI and reusable artifact state in the core. CLI and MCP must access saved reproductions and overrides through the same core operations as the UI; avoid a renderer-only artifact library.

## Delivery sequence

### Phase one navigation and terminology

Implement the four work areas, Project settings, and Advanced tools. Add route compatibility. Move Coverage and Resources into Explore API and make session configuration discoverable. Keep current editors and execution behavior. Update shortcuts, accessible names, empty states, and documentation together.

Exit criterion: every existing capability is reachable through the new structure, old contextual entry points resolve correctly, and existing UI tests pass after intentional label updates.

### Phase two workspace and shared editing

Introduce typed documents, navigation history, per-document dirty state, and recovery persistence. Add comparison and flow documents. Standardize HTTP and WebSocket editor chrome and embed contextual decoding. Implement the shared action registry.

Exit criterion: multi-step navigation and restart preserve work; no restored draft sends traffic; every navigation path follows the same lifecycle rules.

### Phase three endpoint evidence and live overrides

Implement endpoint references, detail aggregation, related-work links, the combined override list, suspension, and transformation explanations. Add group activation after defining overlap and atomicity behavior. Endpoint references must precede durable related-work links.

Exit criterion: the developer can trace an endpoint to evidence, reproduce it, change its live response, and explain the observed result without manually locating related records.

### Phase four reusable reproductions and sessions

Add the saved reproduction library, revisioned run records, assertions, authentication-flow presentation, and session profiles. Provide compatibility adapters for existing macros, flows, and scripts. Integrate their APIs with CLI and MCP.

Exit criterion: saved work reopens and reruns with explicit inputs and session context, and past runs retain their historical definition references.

Do not combine all phases into a single replacement of `AppProvider` and the core metadata model. Ship small vertical slices and keep the application usable between them. Full stateful mock simulation, new protocols, collaboration, and comprehensive credential management are separate projects rather than prerequisites for the navigation milestone.

## Migration and compatibility requirements

- Keep existing IDs for rules, mocks, flows, scripts, and reference tags. Renaming labels must not break token references or MCP tool names.
- Introduce versioned additive metadata and adapters before destructive schema changes. Preserve unknown legacy fields when round-tripping supported records.
- Back up project metadata before any migration that rewrites definitions. Make migrations repeatable and record their version. Do not claim old releases can open migrated data unless tested.
- Keep transient live state out of recovery snapshots. Pauses and active jobs must be refreshed from the running core; disconnected sessions need explicit status.
- Make rule and artifact updates concurrency-aware. Prefer revision checks so two editors cannot silently overwrite each other's changes.
- Preserve user intent during import. Imported definitions should not automatically execute scripts, activate live overrides, or send requests.
- Retention may delete source exchanges. Saved reproductions must retain their own executable definition and show missing evidence gracefully.
- Provide accessible names, visible focus, keyboard navigation, and responsive layouts for every replacement surface. Keep method, status, and state text in addition to color.

## End to end acceptance scenario

Use a local deterministic checkout fixture with login, product listing, order creation, and payment. Include an encoded field and a WebSocket order-status update. Avoid depending on a public website.

1. Create a project and open the fixture through the built-in browser. Select its capture scope and see the resulting traffic.
2. Select order creation and open its endpoint. Inspect a product ID and trace it to the earlier product response.
3. Open the request in Replay. Change an encoded field in the contextual decoder and confirm the outgoing request contains the correctly encoded value.
4. Save it as a named reproduction, add the setup flow and an assertion, and run it. Inspect the related exchange and comparison without losing the editor.
5. Create a payment-failure override from a recorded response. Enable it and exercise checkout in the browser. See the active override summary and its transformation explanation.
6. Suspend overrides and verify checkout returns to the backend behavior. Confirm the configured override remains available and is not deleted.
7. Replay the WebSocket conversation using the same save and run conventions. Inspect an edited-message breakpoint and its original message.
8. Restart the application. Recover the edited workspace without executing traffic. Open the saved reproduction and rerun it deliberately with the selected session.

Automate the state and navigation assertions in UI tests and the persistence, revision, suspension, and execution semantics in core integration tests. Use visual inspection for panel hierarchy, long endpoint labels, dense options, empty states, and narrow windows. Test both light and dark themes.

Track task completion, time to the first successful replay, repeated manual copying, lost-context incidents, and whether a participant can correctly identify active live modifications. Establish a baseline before setting numeric improvement targets. Fewer sidebar entries alone is not evidence of success.

## Completion criteria

The coherence milestone is complete when a developer can follow the acceptance scenario while retaining context, recognize the distinction between evidence and editable work, identify what is modifying live traffic, and reopen a saved reproduction later with understandable configuration. The implementation should preserve the existing technical depth while giving each capability a predictable place in the investigation.

## Source references

The design is grounded in the reviewed versions of these repository files:

- [Application shell](../packages/ui/src/App.tsx)
- [Shared UI state and navigation](../packages/ui/src/state.tsx)
- [Unsaved editor handling](../packages/ui/src/unsaved.ts)
- [API exploration and flow editing](../packages/ui/src/views/Api.tsx)
- [Traffic and coverage entry points](../packages/ui/src/views/History.tsx)
- [Cookies and authentication navigation](../packages/ui/src/views/Cookies.tsx)
- [HTTP replay](../packages/ui/src/views/Replay.tsx)
- [WebSocket replay](../packages/ui/src/views/WsReplay.tsx)
- [Core artifact and rule management](../packages/core/src/powertools.ts)
- [Endpoint coverage inference](../packages/core/src/coverage.ts)
- [Existing UI design](ui-design.md)
- [Recent changes](../CHANGELOG.md)

Recheck these sources before implementation if the baseline has changed. This proposal supplements the earlier UI design; it does not imply that the earlier design's planned capabilities have all been implemented.
