# Privacy notes — the sender photo

**LEGAL_REVIEW_REQUIRED.** This file records what the code does and the
reasoning behind it. It is not legal advice and I am not a lawyer. Everything
below needs a Nigerian data protection practitioner to confirm before real
senders use it.

## What the feature actually is

Every parcel posted through Package Relay now carries a photograph of the sender, taken
at the moment of posting. It is **required** — there is no way to post without
one.

**It is a photograph plus a passive liveness check — not an identity check.**
Since the Dojah integration, the photo is scored for whether it shows a real,
live person. That rejects a printed picture held to the lens, which the earlier
flow accepted. It does *not* reject a video replayed on a second screen, and
nothing compares the face to an ID document or to any database. Nobody is
identified.

This matters in two directions:

- **To senders.** The UI must never say the sender was "verified". It says
  "photo record, not an identity check", and `npm run verify:changes` fails if
  the word verification appears in those components.
- **To you.** If a parcel turns out to contain something illegal, this photo is
  a lead, not proof of who posted it. A liveness pass says a real person was in
  front of the lens — not which person. Treat it as such.

## Where it is stored

Private `sender-photo` bucket. Readable by the sender and by an admin. **Not by
the driver** — a face plus a pickup address handed to every driver browsing the
board is a safety problem for senders, particularly women posting from home, and
it helps the driver with nothing.

No update or delete policy on the bucket, so a photo cannot be swapped after the
fact.

## The lawful basis — this is the part that changed

Earlier the photo was optional and the copy asked for consent. Now it is
required, and that breaks consent as a basis.

The NDPA says that in deciding whether consent was freely given, account is
taken of **whether provision of a service is conditional on consent to
processing that is not necessary for the performance of the contract**. A photo
you cannot refuse and still use the service is not freely-given consent.

So the app no longer asks for consent. It states a **legitimate interest**:

> Drivers carry parcels from strangers. A record of who posted each one protects
> them and deters prohibited items.

That is a real and stateable interest. Whether it survives a balancing test
against the sender's rights is exactly the question a practitioner should
answer, and the answer should be written down before launch — a legitimate
interest you have not documented is one you cannot demonstrate.

**One correction to an earlier note in this repo.** I previously wrote that a
face photo is "likely biometric data" under the NDPA. That was too strong. The
Act treats biometric data as *sensitive* personal data where it is processed
**for the purpose of uniquely identifying** a person. Package Relay does no matching, so
this is ordinary personal data. That stops being true the day a face-matching
vendor is wired into this column, and the sensitive-data obligations would
attach at that point.

## What changed when Dojah was added

Materially, and it needs re-reviewing.

The photo is now sent to a third party — Dojah — which processes it **to assess
whether it shows a real, live person**. Two consequences:

1. **This is closer to biometric processing than storage was.** The NDPA treats
   biometric data as *sensitive* where it is processed for the purpose of
   uniquely identifying a person. Liveness detection is not identification — it
   answers "is this a live human", not "which human" — so the earlier
   conclusion probably still holds. But it is nearer the line than a stored
   photograph, and it is no longer a question to answer by reading the Act
   casually. **Get this one looked at.**
2. **Dojah is a data processor.** That needs a processing agreement, and the
   published privacy notice has to name them as a recipient of the data.

What Dojah returns and Package Relay deliberately does *not* keep: estimated age, gender,
emotion, facial hair, image quality. None is needed to post a parcel and there
is no basis to collect it, so only the verdict, the probability and the
environment ever leave the edge function.

## What is still missing

1. **A retention period.** Photos are kept forever by default. Sending them to
   a processor does not change that and makes it more pressing. This is now the
   fifth item in the schema waiting on a retention decision, alongside rejected
   applications, `app_events`, delivery proof and abandoned capture sessions.
   Mandatory collection makes it more pressing, not less — every parcel produces
   one and nobody chose to give it.
2. **An erasure path.** There is no delete policy on the bucket, so a sender
   exercising a right to erasure cannot currently have these removed.
   `erase_person` in `20250101000009_bans.sql` has the same gap.
3. **The privacy notice itself.** The in-app copy explains the purpose in a
   sentence. A published notice has to say who holds the data, on what basis,
   for how long, who it is shared with, and how to complain to the NDPC.
4. **A DPIA.** Mandatory collection of face photographs from every customer is
   the kind of processing that usually warrants a documented impact assessment.

## If you later want identity matching

Liveness is now done, in sandbox — see `docs/DOJAH.md`. What is still not done
is *matching*: confirming the face belongs to a named person.

Dojah offers it (`/api/v1/kyc/nin/selfie` and similar, matching a selfie against
the photo held against a BVN or NIN). **That is a different legal proposition.**
Matching a face against a record to establish who someone is *is* processing
biometric data for the purpose of uniquely identifying a person, which is the
NDPA's definition of sensitive personal data — with explicit-consent and
impact-assessment obligations attached. It would be a deliberate step with legal
work in front of it, not a configuration change.

## Sources

- [Nigeria Data Protection Act 2023 (full text, NGCERT)](https://cert.gov.ng/ngcert/resources/Nigeria_Data_Protection_Act_2023.pdf)
- [Nigeria's New Data Protection Act, Explained — Future of Privacy Forum](https://fpf.org/blog/nigerias-new-data-protection-act-explained/)
- [Highlights of the Data Protection Act 2023 — ǼLEX](https://www.aelex.com/highlights-of-the-data-protection-act-2023-nigeria/)
