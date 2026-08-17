# Security Policy

## Supported versions

heddle is pre-1.0 and moves forward release by release. Only the most recent release receives
security fixes; a fix ships in the next release rather than as a patch to an older one. If you are
running an older build, updating is the first step.

The current version is shown in the title bar and in [the changelog](docs/changelog.md).

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting instead: go to the
[Security tab](https://github.com/mmayasaurus/heddle-dashboard/security) of this repository and
choose *Report a vulnerability*. The report stays private between you and the maintainers until a
fix is published.

This project is a fork of [VelaTerm](https://github.com/vlinx-io/heddle). If the problem reproduces
on unmodified upstream VelaTerm, please report it upstream as well — fixes for inherited code have
to land there to reach every fork. Problems in this fork's own additions (the agent fleet drawer,
usage and ledger views, and the heddle integration generally) belong here.

A useful report includes the affected version and platform, what an attacker gains, and the shortest
sequence of steps that reproduces the problem. A proof of concept helps but is not required.

## What to expect

heddle is maintained by one person alongside other work, so replies here are best effort rather
than a schedule — expect a first response in days rather than hours. If a week passes with no reply,
please add a note to the report rather than assuming it was ignored; that is far more likely to be a
missed notification than a decision. When I do reply I will say whether it is considered a
vulnerability and why, and keep you posted while a fix is prepared. Once a fix ships, the release
notes describe the issue, and I am happy to credit you by the name or handle you prefer.

## Areas worth a closer look

These parts of heddle handle untrusted input or cross a trust boundary, so findings there are
especially valuable:

- **Browser remote access** — the embedded web server, login and session tokens, device pairing, and
  the end-to-end encrypted channel between a browser and the desktop application.
- **SSH remote development** — host key verification, credential handling, and the provisioning of
  the remote server binary.
- **Terminal escape sequence handling** — output written by a program in a session is untrusted
  input, including OSC sequences used for notifications, titles and clipboard access.
- **Agent integration** — the hook callbacks that report agent status, and the files heddle writes
  into agent configuration directories.
- **File and document handling** — path resolution for opened files, pasted images, and the built-in
  Markdown and source viewers.
- **Fleet integration (this fork's own code)** — the agent fleet drawer and the usage tap: the tap
  sits in front of the Claude Code statusline renderer and writes rate-limit records under
  `~/.heddle/usage/`, and the drawer reads heddle's ledger and roster state. Anything that lets that
  passthrough alter or leak the payload it forwards, or lets untrusted ledger/roster content reach
  the UI as markup or a command, is in scope. Reports here belong in this repository rather than
  upstream.

## Out of scope

Reports that describe an attacker who already has local access to an unlocked machine, or who
already controls a session the user deliberately started, are generally not treated as
vulnerabilities: a terminal is designed to run whatever its user asks it to run.
