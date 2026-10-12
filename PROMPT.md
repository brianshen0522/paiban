# Prompts for the coding agent

Open the coding agent in this folder and paste it the whole "Getting started" section below.

## Before you paste

- **Which machine to run on.** The first phase builds and starts the Docker images and reaches outside websites to check them, so that machine needs Docker (and running), network access, git, and Node.js 22.18 or later (for running the reference tests at the start). Ideally it's the machine you'll host the site on; if not, that's fine too, and the network and performance conclusions will be measured again on the real machine before launch. If anything is missing, the coding agent skips the items it can't do and lists them in the report; it won't get stuck.
- **Keys (can be added later).** If you have a TMDB key or an Assrt (Shooter) token: copy `deploy/.env.example` to `deploy/.env` and fill in `TMDB_KEY`, `ASSRT_TOKEN`, `SUBDL_KEY` at the bottom. If not, don't worry; the checks for those sources are skipped for now. **Don't paste keys in the conversation.**
- The last four lines of "Getting started" are about your environment. Fill in what you know; anything you don't know can be left blank or the whole line deleted.

## Getting started

```text
In this folder you are implementing a self-hosted website called Paiban (拍板). The spec, prototypes, reference code and test fixtures are already here; there is no product code yet, and what you build goes directly in this folder.

Please do these in order:

1. If this folder isn't a git repo yet, run git init first and make the current contents, as they are, the first commit.
2. Read README.md and AGENTS.md, then read all 18 documents in docs/ in the order README lists. While reading, record questions, contradictions and gaps in docs/agent-notes.md.
3. Look at the prototypes: prototype/platform/index.html and prototype/workbench/index.html. If you can, operate them in a browser (prototype/README.md explains how); if not, read the source and screenshots under prototype/.
4. Run the four sets of reference tests listed in the "Commands" section of AGENTS.md and confirm they all pass in your environment (needs Node.js 22.18 or later and the npm registry; if you can't run them, explain why).
5. Tell me in a few paragraphs: what you understand this system is meant to do, how you plan to go about phase 0, and, having read everything, what problems you see in the spec or what needs my decision. Unless a problem blocks phase 0, you don't need to wait for my reply.
6. Start "Phase 0: check the assumptions" in docs/14-plan.md. Do each of its items; anything that can be automated, write as a script and keep it in the repo.
7. Stop when phase 0 is done: write docs/reports/phase-0.md in the format of docs/reports/README.md and give me a summary in the conversation. Don't go on to phase 1 by yourself.

A few things up front:

- "Things you must never do" in AGENTS.md has no exceptions. The three most important: write no code that deletes user files automatically; don't bypass CAPTCHAs or any mechanism that blocks automated access; don't use, store or log anyone else's API key.
- Don't download copyrighted videos for development and testing. Use fixtures/, the fake YTS and local seeding; when you need a real film, use the Blender Foundation's open movies. Automated tests don't use subtitles downloaded from real sources; when checking the sources by hand in phase 0 item 4, download at most one or two subtitle archives per source to look at the format, keep them in .scratch/, and don't commit them.
- Phase 0 item 1 needs deploy/.env. If the file doesn't exist, copy it from deploy/.env.example yourself; generate the database password, SECRET_KEY and the first administrator's password randomly and write them in (if the administrator username is empty, fill in admin), and don't touch values that are already set. Don't print these values or commit them; just tell me where the file is and which two variables hold the administrator's username and password.
- Several phase 0 items need the network, and querying Assrt (Shooter) and TMDB needs keys. I'll fill the keys in myself, in TMDB_KEY, ASSRT_TOKEN and SUBDL_KEY in deploy/.env (only the manual check scripts read them), and won't paste them in the conversation. Skip any source whose key is empty and list it in the report; when I add it later I'll ask you to do it then.
- Keep requests to real websites to a minimum: a few requests per source is enough, do it only once, and save the responses for reuse.
- If you can't do something (for example, no Docker, no network, no browser), tell me directly which item and why, then carry on with whatever else you can do. Don't pretend you did it, and don't quietly switch to a different approach.
- When the spec differs from the facts you find, the facts win: change the documents, record it in docs/changes.md, and tell me in the report.
- Communicate with me in Traditional Chinese. Code, comments and commit messages in English.

My environment:
- This machine (operating system; is Docker running; can it reach the internet):
- The machine I'll deploy to (is it this one; CPU, memory, disk size, x86 or ARM):
- A YTS address that currently works:
- Keys: (already in deploy/.env / will add later)
```

## Each phase after that

After reading the report and answering its questions, paste this. Replace N with the number and write your replies in the middle.

```text
I've read the phase N report.

(Your reply to each item under "What Brian needs to decide or provide" in the report. If there's nothing, write "Nothing to add.")

Please continue with the next phase of docs/14-plan.md. Before starting, reread the documents that phase lists; when it's done, stop and write the report the same way, and don't go on to the phase after that by yourself.
```

The ten phases in order: 0 check the assumptions, 1 accounts and shell, 2 search and film page, 3 downloads and the storage limit, 4 video analysis and preview, 5 subtitle sources, 6 sync workbench, 7 export, 8 admin and notifications, 9 launch preparation.

## When you start a new conversation

The coding agent doesn't remember the previous conversation. When starting over, paste this first so it can recover its progress from the files.

```text
This folder is the Paiban (拍板) project, implemented about halfway.

Please read AGENTS.md, docs/00-decisions.md, docs/14-plan.md, docs/changes.md, docs/agent-notes.md, and the highest-numbered report in docs/reports/; then look at the last twenty commits in git log and the current state of the working directory.

Then tell me: which phase we're at, what's left in that phase, and whether anything is half-done and uncommitted. Don't change any files yet; wait for me to say what's next.
```

## When you want it to change something

For requests outside the plan (changing a screen, adding a feature, fixing a problem), just say it in your own words. Two habits make the results better:

- Say clearly what result you want, not how to do it. For example, "the cards in the Library are too tall on a phone; only one fits on a screen", rather than "make the padding smaller".
- If the request changes the spec, ask it to change the corresponding documents in `docs/` too and record it in `docs/changes.md`. That way the documents are still right when you switch conversations later.
