# Get started with Crank

Crank turns an event from one app into a run for a person to review. Only an
owner can select **Approve and deliver**. Creating a flow, receiving an event
or importing a workflow does not send anything to its destination.

## Open your workspace

To start from nothing, run:

```sh
curl -fsSL https://runeditrun.com/install.sh | sh -s -- dev just-every/run-crank
```

Git is required; rer brings Node and pnpm. Already have Node 22 or later? `npx -y @runeditrun/rer dev just-every/run-crank` does the same. The line installs `rer` and gets Crank into a `run-crank` folder. If the installer prints a line that puts `rer` on your PATH, run that line too. To start it again later, run the same line from the same folder, or `cd run-crank && rer dev`.

The first start can take several minutes. Keep the terminal open, open the
private **RER_OPEN** link it prints, and complete **Finish setup**. Treat that
link as a sign-in credential. Local development messages stay in the local
outbox; they are not emailed externally. If the command times out, run it again
to resume. Stop Crank with `rer dev --stop`.

For the clone command, installing the runner or setting up your own owner email,
see [Run it in the README](../README.md#run-it).

## Deliver your first event

The included **Operations inbox** is a separate receiving app. In a second
terminal, from the same checkout, start it with:

```sh
npm exec --yes --package=node@22.20.0 -- node examples/inbox/server.mjs
```

Open `http://127.0.0.1:9051`. Messages are stored locally in
`.rer/inbox/inbox.sqlite`. Keep its terminal open too; stop the inbox with Ctrl-C.

1. Open **Flows** at `/app`. Under **Create a flow**, enter **Support follow-up**
   for **Flow name**, **Support desk** for **Source app**, **Operations inbox**
   for **Destination app**, and `http://127.0.0.1:9051/events` for
   **Destination URL**. Select **Create draft flow**.
2. On the new flow, select **Activate flow**. Expand **Prepare a run** and enter
   `ticket-1042` as the **Event ID**. For **Event input (JSON object)**, enter:

   ```json
   {"customer":"Harbor Workshop","task":"Book a callback"}
   ```

3. Select **Prepare for approval**. On **Run details**, check the source,
   destination URL and **Exact input sent on approval**. Nothing has been sent yet.
4. Select **Approve and deliver**, then inspect **Approval history** and
   **Delivery attempts**. Refresh the Operations inbox to see the message.

Manual preparation lets you try the approval step before connecting a source.
A source app uses a flow-specific trigger credential to submit events; it cannot
approve delivery. An agent can prepare flows and runs for you to inspect.

## What to do next

- [Flows and runs](FLOWS-AND-RUNS.md): pause a flow, reject a run and use one manual replay.
- [Access](ACCESS.md): invite people or connect a source or agent.
- [Move in from n8n](IMPORTING.md): review a supported workflow before importing it.
- [Backup, restore and erasure](BACKUP-RESTORE.md): keep your data and preserve deletion records.

Your own receiving app must implement Crank's
[destination contract](FLOWS-AND-RUNS.md#connect-your-own-destination) before you use
it for deliveries.
