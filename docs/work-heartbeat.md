<!-- SPDX-License-Identifier: Apache-2.0 -->

# Turn-end continuation instead of default polling

The automatic five-minute model heartbeat is replaced by a turn-end continuation
checkpoint. Explicit `/heartbeat` schedules remain supported and are not deleted.
No heartbeat is installed automatically on idle ticks.

During working execution `plugin_task_continuation` records continue (with concrete
next step), waiting, blocked or completed. Only continue can create a follow-up.
It is included with the original turn's durable inbox/outbox completion snapshot.
The pump never recursively calls a model and runs follow-ups only after persistence
and pending replies, respecting pause/shutdown. Existing queued input takes priority;
no automatic continuation is added over it. Failed/cancelled turns do not continue.
API run inputs are excluded. A chain is limited to 20 follow-ups. This is not a full
task registry: waiting states need external events or explicit new input to resume.
Authorization is still enforced by normal tools/review, not by a next-step string.
The tool records a plan; it does not infer completion reliably from arbitrary prose.
An explicit completed checkpoint can still be independently assessed against the
original authorized task. Only a valid concrete continue plan replaces it; an
unavailable or inconclusive assessment preserves completed. Waiting and blocked
checkpoints are not reassessed, and cancellation, pause, expiry and chain limits
still prevent automatic follow-ups.

Self-improvement starts via Cron at the configured local start hour, and a separate
Cron triggers the morning report. The committed-turn hook requests the next night
step; a five-minute state-only recovery Cron repairs deferred/interrupted night
scheduling without installing a generic model polling heartbeat. Cron start intent
is persisted even while interactive work is busy. Cron timezone/hours changes need
restart; enable/budget are read on checks. Existing in-flight work is not preempted.
Deployment is required; source changes do not activate the running installation.
