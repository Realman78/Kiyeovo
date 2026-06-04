# AGENTS.md

## Purpose

This file defines how coding agents should work in this repository. It does **not** replace the architectural documentation. It defines workflow, approval, quality, and documentation-sync rules.

## Primary Architecture Reference

[Kiyeovo_desktop_technical_documentation.md](./Kiyeovo_desktop_technical_documentation.md) is the technical documentation for the project. Before making non-trivial changes, read the relevant sections.

Treat that document as the primary architectural reference.

If the code and the document disagree, do **not** silently choose one. Call out the mismatch.

## Documentation Sync Rule

The technical documentation may lag behind the code. Agents must treat that as a maintenance problem, not as a reason to ignore the document.

If a change affects any of the following, update [Kiyeovo_desktop_technical_documentation.md](./Kiyeovo_desktop_technical_documentation.md) in the same task unless the user explicitly says not to:

- architecture
- lifecycle behavior
- protocol behavior
- persistence or DB behavior
- recovery or reconnect behavior
- security-relevant behavior
- user-visible system behavior

Minor mechanical edits do not require documentation updates.

## Approval Workflow

Agents may inspect code, read files, and analyze architecture without approval.

Agents must **not** edit code, documentation, configuration, or tests until the user explicitly approves the proposed work.

Before editing, provide:

- a short problem summary
- the proposed approach
- the main files to change
- the main risks or tradeoffs

Wait for explicit approval before writing code. Keep answers informative, but concise. Quality over quantity.

An explicit instruction such as `do it`, `implement it`, or `patch it` counts as approval.

## Assumption Policy

Do not make assumptions about:

- architecture
- lifecycle ownership
- protocol semantics
- recovery behavior
- persistence rules
- user intent when multiple design paths are plausible

Ask the user instead.

Low-risk mechanical assumptions are acceptable only when they do not change product behavior or architectural direction.

If the behavior is ambiguous, **stop and ask**.

## Engineering Expectations

Use best practices. This is a P2P electron application focused on security and privacy. Keep that in mind and follow best practices in those topics.

Regarding code:

- prefer clear ownership of state and behavior
- keep responsibilities narrow
- avoid adding cross-cutting behavior casually
- prefer explicit transitions over incidental side effects
- prefer small, reversible changes over wide speculative rewrites
- keep logic close to the subsystem that owns it
- preserve existing invariants unless the change intentionally redefines them

Do not patch behavior blindly. Before modifying recovery, lifecycle, or protocol logic, identify:

- who owns the state
- what transitions are legal
- what other subsystems observe or depend on that state

If you cannot identify a clear owner, escalate before coding.

## Architecture Discipline

Do not treat overloaded files as the default place for new logic just because they already contain related code.

When touching a complex area:

- first check whether the logic belongs in an existing lower-level component
- prefer extracting focused helpers/services over growing orchestration code further
- call out when a requested change increases coupling or spreads lifecycle logic across layers

If a change would introduce another timer, retry loop, global callback, or side-channel recovery hook, explicitly justify why existing lifecycle machinery is not sufficient.

## Logging Policy

During debugging or creating a new feature that needs testing, add temporary logs IF NECESSARY. Tag them by putting a "TEMP_LOG" comment above them so that they can be easily deleted later.

## Verification

After changes:

- run the smallest relevant verification possible
- report what was actually verified
- report what was not verified

## Review Standard

If the user asks for a review, focus on:

- correctness
- lifecycle clarity
- state ownership
- regressions
- protocol or persistence risks

Do not prioritize style feedback over correctness or architecture.
