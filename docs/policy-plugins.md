# Runtime policy modules (API v1)

The CLI stages trusted local policy implementations at an instance-wide idle
boundary. `/policy-plugin` is admin-only by default, like other plugin commands.
It does not expose a policy-changing model tool.

- `/policy-plugin status`
- `/policy-plugin use review plugins/my-review.mjs`
- `/policy-plugin reload review`
- `/policy-plugin disable optional-policy`
- `/policy-plugin baseline review`

Desired overrides persist as `policyPlugins` in `settings.local.yaml`; paths resolve
against Harness home. `baseline` removes the override and restores the policy
captured before its first managed replacement (or removes a newly added optional
policy). Required identities, including `review` when configured, can be replaced
but not disabled. This does not migrate or reset the review ledger, findings,
assessments or budget. The bundled review engine and default composition are owned by `harness/plugins`;
the host keeps configuration compatibility and generic policy lifecycle.

A local ESM entry exports default:

```js
export default {
  apiVersion: 1,
  async create({ home, cwd, agent }) {
    return {
      policy: { id: 'example', async beforeTool(cwd, tool, input) {} },
      async start() {},
      async stop() {},
    };
  },
};
```

`policy` implements the composable Policy hooks. `create` only prepares resources;
`start` activates them. `stop` must fully quiesce resources and permit a subsequent
`start` for rollback. Methods retain their receiver. Do not register additional
policies or start unmanaged receivers from a factory. Modules must honor shutdown
and must not leave background hooks running after stop.

The candidate is imported, validated and started inside the Harness idle reservation;
no turns start and new inbound acceptance is refused for upstream retry. The old
instance is stopped before the registry switches to the candidate. This provides a
whole-turn boundary for CLI-managed turns, not for arbitrary external direct calls
to the registry. Use independent coordination if calling hooks outside the Harness.
Overlapping requests retain the newest pending generation; superseded candidates
are cleaned up. Shutdown serializes pending preparation and drains turns before
stopping active policy resources.

Invalid preparation/start keeps the previous policy. Failed old stop attempts to
restart the previous instance. Failed cleanup or failed rollback makes lifecycle
health uncertain: the affected identity receives throwing hooks, status reports
`degraded`, and further replacement requires process restart. Status never claims
successful rollback in that case. Desired configuration remains persisted after a
failed activation; repair it before restart. Invalid initial overrides fail startup.
Module exception text is not included in status because it may contain secrets.

This is **trusted in-process JavaScript**, not a sandbox or a download mechanism.
Admin-installed modules can access files and credentials. An activation cache-busts
only its ESM entry; imported dependencies remain cached. Deploy complete versioned
module directories for changes. Node does not unload old imports; unlimited reloads
and untrusted modules require process isolation, not implemented here. There is no
activation timeout or forced termination of a hung factory. Build/merge does not
activate a running deployment; GitOps rollout or process restart remains separate.
