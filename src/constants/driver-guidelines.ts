/**
 * Driver guidelines and FAQs.
 *
 * Written from what this app and this business actually do — the review window
 * is `REVIEW_WORKING_DAYS`, the approval gate is the one in
 * `use-driver-eligibility`, the fare is what `estimateFee` quotes. Where the
 * app does not do something yet, the answer says so instead of describing a
 * feature that does not exist.
 *
 * Content lives here rather than in the screen so it can be checked against the
 * code by the verification script, and edited without touching layout.
 */

export type Guideline = {
  key: string;
  title: string;
  body: string;
};

export const REQUIREMENTS: Guideline[] = [
  {
    key: 'identity',
    title: 'A verifiable identity',
    body: 'Your National Identification Number, your address, and a government photo ID. The NIN is checked against the name on your application.',
  },
  {
    key: 'vehicle',
    title: 'A roadworthy vehicle in your name',
    body: 'Bike, car or van, with a valid plate number and a current driver’s licence. The plate you register is the one we expect to see at a hub.',
  },
  {
    key: 'guarantor',
    title: 'A guarantor we can reach',
    body: 'Someone who is not a member of your household, with their own NIN and a phone they answer. We call guarantors. Applications where the guarantor cannot be reached are not approved.',
  },
  {
    key: 'payout',
    title: 'A bank account in your own name',
    body: 'Payouts go to the account on your application. We do not pay a third party, and an account name that does not match your own will hold up your application.',
  },
];

export const CONDUCT: Guideline[] = [
  {
    key: 'accept',
    title: 'Only accept what you can actually carry',
    body: 'Check the weight, size and route before claiming. A job you drop after accepting leaves a sender waiting with no cover, and it is the fastest way to lose access.',
  },
  {
    key: 'window',
    title: 'Collect inside the pickup window',
    body: 'Every job shows a window. If you are running late, call the sender on the number attached to the job before the window closes, not after.',
  },
  {
    key: 'handling',
    title: 'Treat a fragile parcel as fragile',
    body: 'Package Relay does not charge extra for fragile items, which means there is no insurance premium behind them. If a parcel is marked fragile, it travels upright, secured, and not under anything.',
  },
  {
    key: 'handover',
    title: 'Hand over to the named recipient',
    body: 'The job carries a recipient name and phone number. Deliver to that person or to the hub named on the job. Do not leave a parcel with a neighbour, a gateman or a shop.',
  },
  {
    key: 'privacy',
    title: 'A sender’s details are not yours to keep',
    body: 'Addresses and phone numbers on a job exist so you can complete that job. Using them for anything else — including contacting a recipient afterwards — ends your access permanently.',
  },
];

export type Faq = {
  key: string;
  question: string;
  answer: string;
};

export const FAQS: Faq[] = [
  {
    key: 'how-long',
    question: 'How long does approval take?',
    answer:
      'Up to 7 working days from the day you submit. You can watch it move under Be a Driver / Updates. If you are past 7 working days, that screen says so and you should chase us.',
  },
  {
    key: 'browse-before',
    question: 'Can I see jobs before I am approved?',
    answer:
      'Yes. Find Open Jobs is open to everyone, and you can see the routes, weights and fares. The Accept button stays greyed out until an admin approves your application — browsing is not gated, claiming is.',
  },
  {
    key: 'notified',
    question: 'How will I know when I am approved?',
    answer:
      'The status on Be a Driver / Updates changes as soon as a reviewer records the decision, and if you have the app open you get a notification straight away. Decision emails are not switched on yet, so do not wait on your inbox for this one.',
  },
  {
    key: 'confirmation-email',
    question: 'I did not get the confirmation email.',
    answer:
      'Check your spam folder first. Be a Driver / Updates shows exactly whether that email was sent, failed, or was never attempted — so you can tell the difference rather than guessing. Your application is safe either way.',
  },
  {
    key: 'rejected',
    question: 'What happens if my application is rejected?',
    answer:
      'You will see the outcome, and the reviewer’s note if they left one, under Be a Driver / Updates. One live application is allowed per account, so re-applying means the old record has to be cleared first — contact support.',
  },
  {
    key: 'paid',
    question: 'When and how do I get paid?',
    answer:
      'Delivering a parcel credits your Driver Wallet, net of Package Relay’s commission. New money sits on a short security hold, then you can request a payout to the bank account on your application — Package Relay makes that transfer by hand, so it is not instant. The figure shown on a job is the gross fare quoted to the sender and will always be higher than what lands in your wallet; the Wallet balance is the one to trust.',
  },
  {
    key: 'edit-details',
    question: 'How do I change my vehicle or phone number?',
    answer:
      'Not from the app. Those details were verified during review, so changing them has to go back through a person — email support. A plate that does not match the one on your application will be turned away at a hub.',
  },
  {
    key: 'multiple',
    question: 'Can I carry more than one job at a time?',
    answer:
      'Yes. Anything you have claimed appears under Your deliveries in the Driver Portal, split into in progress and delivered. Only claim what you can actually complete inside each job’s window.',
  },
  {
    key: 'documents',
    question: 'Who can see the documents I uploaded?',
    answer:
      'You and Package Relay reviewers, nobody else. They are held in a private store and opened through short-lived links, so a URL that leaks does not stay usable. Other drivers cannot see them.',
  },
  {
    key: 'stop',
    question: 'Can I stop driving?',
    answer:
      'Yes, at any time — there is no minimum. Finish or hand back anything you have already accepted first, so no sender is left without a carrier.',
  },
];
