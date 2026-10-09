# Virtual Office — original brief

## The idea

A small business owner should be able to open one screen and see their whole
back office working: an agent per department, each one drafting real work, and
a queue of things waiting for a yes or no. The agents are autonomous in the
sense that nobody triggers them by hand — a lead arrives, the Sales agent
picks it up, writes a reply and puts it in front of a human. Nothing a customer
could ever read goes out without that human click.

It is self-hosted on purpose: the model runs locally through Ollama, the
automation runs in n8n, and the data stays in Postgres on the owner's machine.

## Who it is for

Philippine service SMBs — electrical contractors, managed IT shops, anyone
answering the same enquiries on email, Messenger and Shopee all day. Prices in
PHP, business hours in Asia/Manila. One deployment serves several businesses,
because the people running this are usually running more than one.

## The office metaphor

The dashboard is a floor plan, not a table. Nine desks per business, one per
department: Sales, Marketing, CRM, Inventory, HR, Admin, Logistics, Security,
Production. Each desk shows its agent and what it is doing right now — idle,
working, waiting on you, or switched off. Clicking a desk is how you review
its work. The metaphor is the point: an owner should be able to glance at the
room and know whether anything needs them.

## Non-negotiables

1. **A human approves everything outbound.** Drafts are drafts until somebody
   says otherwise. Rejection is not a delete — it goes back with feedback and
   the model tries again.
2. **A kill switch that actually stops work.** One click pauses an agent, and a
   paused agent cannot be restarted by a retry, an approval, or an n8n run that
   was already in flight.
3. **One deployment, several businesses, no leakage.** A tenant's rows, events
   and sockets never reach another tenant — and once there are accounts, the
   scope comes from who you are, not from what the browser asks for.
4. **The database is the truth.** The screen reflects what Postgres committed,
   not what a process believes it did. A change made in psql, in n8n, or by a
   second backend instance shows up in the UI the same way a click does.
5. **An audit trail.** Every transition is written down: who approved what,
   when, and what the feedback was.

## Shape of the system

```
lead ─► n8n webhook ─► checkout agent (backend) ─► Ollama draft
                                   │
                                   ▼
                         approvals row = PENDING
                                   │
                      Postgres NOTIFY ─► backend LISTEN ─► Socket.io ─► dashboard
                                   │
                        human approves / rejects
                           │              │
                   n8n dispatch       n8n replay with feedback
```

## Deliberately out of scope for v1

- Self-serve sign-up, password reset email, and role enforcement. Accounts are
  made by whoever runs the stack, and everyone with an account can approve.
- Workflows for the other eight departments. Sales proves the pattern; the rest
  are seeded and visible so the room looks right while they get built.
- Real channel senders. The dispatch workflow routes by channel into
  placeholders — wiring Meta, Shopee and email is per-business work.
- A hosted LLM fallback for when Ollama is down.
