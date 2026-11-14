---
"a2a-claude": patch
---

Ignore background tasks the SDK flags `ambient: true` (skip_transcript tasks and live-update watchers) when deciding whether to hold the A2A Task open and when publishing `background_tasks` events. The SDK marks these as "not activity" and asks hosts to exclude them from activity indicators; counting them left a Task in `working` after Claude's final answer with nothing the user could see.
