# AGENTS.md — hermes-mender

## Git-Arbeitsregel: geschützter Hauptzweig (01.11.2026)
`main` ist in diesem Repository per Ruleset geschützt.
- Nie direkt auf `main` committen, pushen, mergen oder rebasen. Tags nur wie im letzten Punkt beschrieben.
- Jede Änderung auf einem eigenen Branch; nur signierte Commits. Signatur nicht abschalten oder umgehen (kein --no-gpg-sign, kein -c commit.gpgsign=false).
- In `main` nur per Pull Request mit Squash-Merge. Kein Force-Push, kein Löschen von `main`, Rulesets/Branchschutz nicht ändern oder umgehen (auch kein Admin-Bypass).
- Agenten dürfen ihre eigenen PRs selbst squash-mergen, aber erst wenn alle Prüfungen grün sind: CI mit gitleaks, semgrep und Tests. Fehlt eine dieser Prüfungen, läuft sie noch oder schlägt sie fehl, wird nicht gemergt, sondern an den Maintainer gemeldet.
- Release-Tags erst nach dem Squash-Merge auf den entstandenen Commit in `main` setzen (signiert).
