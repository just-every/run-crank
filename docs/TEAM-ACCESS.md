# Native team access

The owner assigns explicit grants on Access. Each grant combines a product role with named workflows and accounts. Add another grant to retain an existing one, or replace the set deliberately. An empty set grants no product access. A Base sign-in role alone grants no product access.

One grant must cover the requested action, workflow and every account used by that action. A builder grant for a workflow cannot borrow account access from a viewer grant. Admins may delegate within one of their own grants; they cannot change owner settings, issue credentials or administer another person's broader access.

Operators can preview and replay eligible failed steps in their scope. Completed effects stay complete and uncertain writes require reconciliation. Draft tests retain the initiating builder's authority revision, and publication retains its immutable execution authority. Removing access fences the next request and an admitted write before commit.

A starter cannot approve their own workflow run or legacy approval flow, including an owner. Rejection remains available to an otherwise authorized reviewer. A production-account draft test also needs a different native owner to confirm its exact effect.

Auditors read value-free audit history from their Account page. Billing administrators read monthly aggregate run counts and accounting units. These doors omit customer values, account credentials, workflow names and per-run details. Neither duty grants workflow or account access.

The one-time database upgrade snapshots existing non-owner access to existing workflows and accounts, with explicit action limits and a retained report available to the owner at `/api/crank/team/migration`. New records and new people acquire no fallback permissions. Neither grants nor migration reports travel in a portable archive.

TEAM-001 remains partial. Folder and environment grants, native group and SCIM provisioning, delegated creation, complete legacy administration and migration preservation of creation privileges remain work. Interoperability with Okta, Entra and Auth requires the owner's actual IdP tenant. The local migration journey proves existing record access and no widening; it does not establish the remaining creation-privilege obligation.
