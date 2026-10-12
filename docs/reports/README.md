# Phase reports

At the end of each phase, put a `phase-N.md` here, in English (since 2026-10-12; the summary told to Brian in conversation is in Traditional Chinese), for Brian to read. Once it's written, stop and wait for his confirmation.

Each one contains:

1. **Conclusion** (three sentences at most): whether this phase is done; whether there's anything he needs to know right away.
2. **What was done**: listed by feature, no need to list files.
3. **Acceptance**: every item for that phase in `docs/14-plan.md`, each marked passed or not passed. For ones that didn't pass, give the reason and the plan.
4. **Tests**: what was run, how many, the results. For things not automated, say how they were checked by hand.
5. **Differences from the spec**: point to the relevant entries in `docs/changes.md`.
6. **Problems and risks found**: including ones outside this phase's scope that you noticed.
7. **What Brian needs to decide or provide**: for each item, state the options and your recommendation clearly.
8. **How to see the results**: commands starting from scratch, plus which URL to open and what to try. Don't write out usernames and passwords: write "the credentials are in these two variables in `deploy/.env`".

The phase 0 report must also have:

- A conclusion for each of items 3 to 7 of phase 0 in `docs/14-plan.md`: confirmed, does not match (with what actually happens and a suggested spec change), or could not be confirmed (with the reason and what's needed).
- Findings that could shake the architecture go first.
- The "Things for Brian to confirm" table at the end of `docs/16-risks.md`, listed again verbatim for him to answer.
- Every entry in `docs/agent-notes.md` marked "needs Brian to confirm".

If something isn't done, say it isn't done; if something isn't verified, say it isn't verified. No keys, passwords or tokens in reports.
