# Native team access

The owner assigns explicit grants on Access. Each grant combines a product role with named workflows and accounts. Add another grant to retain an existing one, or replace the set deliberately. An empty set grants no product access. A Base sign-in role alone grants no product access.

One grant must cover the requested action, workflow and every account used by that action. A builder grant for a workflow cannot borrow account access from a viewer grant. Admins may delegate only actions covered by one of their own complete grants; an approver grant alongside an admin grant cannot supply missing delegation powers. They cannot change owner settings, issue credentials or administer another person's broader access.

Run-list payloads are checked against each workflow's complete read grant, regardless of grant order. Status-only grants never acquire customer values from a separate builder grant, including in legacy history and text or business-key searches.

Operators can preview and replay eligible failed steps in their scope. Completed effects stay complete and uncertain writes require reconciliation. Draft tests retain the initiating builder's authority revision, and publication retains its immutable execution authority. Removing access fences the next request and an admitted write before commit. Editor controls and approval availability check the complete grant for their own action and all accounts, even when a different role appears first.

Standing-grant reviewers receive only the proposed effects for tasks under the particular grant that names them; this confers no workflow-wide approval or payload access.

A starter cannot approve their own workflow run or legacy approval flow, including an owner. Rejection remains available to an otherwise authorized reviewer. A production-account draft test also needs a different native owner to confirm its exact effect.

Auditors read value-free audit history from their Account page. Billing administrators read monthly aggregate run counts and accounting units. These doors omit customer values, account credentials, workflow names and per-run details. Neither duty grants workflow or account access. A person assigned both duties sees both entry points on Account, regardless of grant order.

The one-time database upgrade snapshots existing non-owner access to existing workflows and accounts, with explicit action limits and a retained report available to the owner at `/api/crank/team/migration`. New people acquire no fallback permissions. An admin holding an explicit production workspace grant may delegate production creation within that grant. This grants only the recipient’s own new records, not the administrator’s records. An explicit production workspace grant permits creating production drafts and reading or preparing the records that person creates; it never grants another person's future records. Migrated administrators retain that creation privilege without gaining publication or draft execution. Adding an explicit grant preserves every existing migration action limit; submitted action limits cannot replace them. The append is fenced against the same recipient revision that was reviewed. Neither grants nor migration reports travel in a portable archive.

TEAM-001 remains partial. Folder and environment grants, native group and SCIM provisioning, complete legacy administration and broader folder and environment administration remain work. Interoperability with Okta, Entra and Auth requires the owner's actual IdP tenant. The local migration journey proves existing record access, creation of an owned production draft, cross-environment refusal and no access to another person's later record.
