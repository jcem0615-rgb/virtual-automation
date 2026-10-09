// The trades a floor can be opened for.
//
// Every office gets the same ten desks, the same skills and the same rules —
// what changes with the line of business is what those desks are *called*, so
// a salon's floor does not read like an electrical contractor's. That is the
// whole difference: same features and logic, different business line and its
// own data, which is kept apart by the tenant filter like any other floor.

const BASE_TITLES = {
  Sales: 'Sales Agent',
  Marketing: 'Marketing Agent',
  CRM: 'Customer Care Agent',
  Payments: 'Payment Collector',
  Inventory: 'Inventory Agent',
  Logistics: 'Dispatch Agent',
  Production: 'Operations Agent',
  Admin: 'Admin Agent',
  HR: 'People Agent',
  Security: 'Security Agent',
};

export const BUSINESS_LINES = [
  {
    key: 'electrical',
    label: 'Electrical services',
    blurb: 'Installation and repair work quoted per site visit.',
    titles: { Production: 'Job Supervisor', Logistics: 'Crew Dispatcher', Inventory: 'Materials Agent' },
  },
  {
    key: 'it_services',
    label: 'IT services',
    blurb: 'Managed support, hardware and projects.',
    titles: {
      Sales: 'Account Executive', Marketing: 'Demand Gen Agent',
      CRM: 'Client Success Agent', Inventory: 'Asset Agent',
      Logistics: 'Deployment Agent', Security: 'SecOps Agent',
      Production: 'Service Desk Agent', Payments: 'Billing Agent',
    },
  },
  {
    key: 'retail',
    label: 'Retail and online selling',
    blurb: 'A catalogue sold through shops, socials and live streams.',
    titles: {
      Sales: 'Shop Agent', Marketing: 'Content Agent', Inventory: 'Stock Agent',
      Logistics: 'Fulfilment Agent', Production: 'Packing Agent',
      Payments: 'Collections Agent',
    },
  },
  {
    key: 'food',
    label: 'Food and beverage',
    blurb: 'Orders, deliveries and a kitchen that has to keep up.',
    titles: {
      Sales: 'Orders Agent', Inventory: 'Commissary Agent',
      Production: 'Kitchen Agent', Logistics: 'Rider Dispatcher',
      Security: 'Food Safety Agent',
    },
  },
  {
    key: 'construction',
    label: 'Construction',
    blurb: 'Projects, materials and crews on several sites.',
    titles: {
      Sales: 'Bidding Agent', Production: 'Site Agent',
      Inventory: 'Materials Agent', Logistics: 'Haulage Agent',
      Security: 'Safety Officer', Admin: 'Permits Agent',
    },
  },
  {
    key: 'logistics',
    label: 'Logistics and delivery',
    blurb: 'Bookings, routes and proof of delivery.',
    titles: {
      Sales: 'Booking Agent', Logistics: 'Routing Agent',
      Production: 'Hub Agent', Inventory: 'Fleet Agent',
      Payments: 'Freight Billing Agent',
    },
  },
  {
    key: 'salon',
    label: 'Salon and wellness',
    blurb: 'Appointments, packages and regulars.',
    titles: {
      Sales: 'Booking Agent', CRM: 'Front Desk Agent',
      Production: 'Service Agent', Inventory: 'Supplies Agent',
      Logistics: 'Branch Agent',
    },
  },
  {
    key: 'professional_services',
    label: 'Professional services',
    blurb: 'Billable work sold by the engagement.',
    titles: {
      Sales: 'Business Development Agent', Production: 'Delivery Agent',
      Payments: 'Billing Agent', Admin: 'Engagement Admin',
      Inventory: 'Resourcing Agent',
    },
  },
  {
    key: 'general',
    label: 'Something else',
    blurb: 'The plain set of desks, named as they come.',
    titles: {},
  },
];

export const BUSINESS_TYPES = BUSINESS_LINES.map((l) => l.key);

export const businessLine = (key) =>
  BUSINESS_LINES.find((l) => l.key === key) ?? BUSINESS_LINES.at(-1);

/** The role title each desk carries on a floor of this kind. */
export function titlesFor(key) {
  const line = businessLine(key);
  return { ...BASE_TITLES, ...line.titles };
}

/**
 * A code for a new floor, derived from its name. Codes are how a human refers
 * to a business in the operator's portal and in scripts, so they are short,
 * loud and unique — the caller retries with a suffix on a clash.
 */
export function codeFromName(name, attempt = 0) {
  const base = String(name)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24) || 'OFFICE';
  const stem = /^[A-Z]/.test(base) ? base : `B_${base}`;
  return attempt ? `${stem.slice(0, 27)}_${attempt + 1}` : stem;
}
