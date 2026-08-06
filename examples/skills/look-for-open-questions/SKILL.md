---
name: Look for open questions
description: Sweeps the places people ask you things and publishes a report of what is still waiting on you.
emoji: "❓"
schedule: weekdays
schedule_time: "08:30"
canvas: true
space_mode: reuse
---

# Look for open questions

Find the things people are waiting on me for, across every place they might have
asked, and put them in one report I can work through.

This runs unattended on a schedule, so the run has to be self-contained: no
questions back to me, and no work left implied but undone.

## What to look for

A question counts if someone is waiting on a human answer and has not received
one. Look wherever the workspace has access — issues and pull requests, chat, a
task tracker, email, and anything else configured through MCP. Skip whatever is
not available rather than treating its absence as an error.

Prefer these, in order:

1. Direct questions addressed to me that have no reply.
2. Review requests and mentions where I am the blocker.
3. Threads where a decision was asked for and the conversation stalled.
4. Items that were answered but whose follow-up never happened.

Deliberately exclude:

- Anything I have already answered, even if the thread stayed open.
- Automated messages and bot chatter.
- Questions clearly aimed at someone else.

## How to judge them

For each question, work out three things:

- **What is actually being asked** — one sentence, in plain language, not a
  copy of the original message.
- **Why it is still open** — waiting on me, waiting on information, or simply
  forgotten.
- **A candidate answer** — if the workspace, the repository, or the thread's own
  history already contains the answer, say what it is and where you got it. If
  it genuinely needs my judgement, say that instead of guessing.

Include a direct link to the source for every item. A report I cannot act from
is worse than no report, because it costs me the time to go find everything
again.

## The report

Group items by how urgent they are — blocking someone else, waiting on me, and
worth a look — and sort each group oldest first, since an old question is
usually the more embarrassing one.

For each item show: the question, who asked and when, why it is open, the
candidate answer if there is one, and the link.

Open with a one-line summary of the shape of things, for example "4 people are
blocked on you, 9 questions total". Use that same line as the report `status` so
I can read it from the tray without opening anything.

If nothing is open, publish a report that says so. That is a genuine result and
I want to see it, not silence.

## Refreshing

This skill reuses its space, so each run updates the same report rather than
piling up new ones. Before writing, read the previous report and its
`data.json` if they exist, and use them to:

- Keep a stable id per question so items do not appear new when they are not.
- Mark what is newly open since the last run, and what has been resolved.
- Preserve any answer I already drafted rather than overwriting it.

Alongside the HTML, write a `data.json` containing the structured items, so the
next run has something better than the rendered page to compare against.
