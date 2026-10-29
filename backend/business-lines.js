// The trades a floor can be opened for.
//
// Every office gets the same eleven desks, the same skills and the same rules —
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
  Secretary: 'Secretary',
};

export const BUSINESS_LINES = [
  // Trades, roughly by how common they are as a small business here. The
  // order is the order the dialog offers them in; `general` stays last
  // because it is the answer when none of the others fit.
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
    key: 'electrical',
    label: 'Electrical services',
    blurb: 'Installation and repair work quoted per site visit.',
    titles: {
      Production: 'Job Supervisor', Logistics: 'Crew Dispatcher',
      Inventory: 'Materials Agent',
    },
  },
  {
    key: 'construction',
    label: 'Construction',
    blurb: 'Projects, materials and crews on several sites.',
    titles: {
      Secretary: 'Site Clerk',
      Sales: 'Bidding Agent', Production: 'Site Agent',
      Inventory: 'Materials Agent', Logistics: 'Haulage Agent',
      Security: 'Safety Officer', Admin: 'Permits Agent',
    },
  },
  {
    key: 'hardware',
    label: 'Hardware and building supply',
    blurb: 'Counter sales, deliveries and stock that moves by the pallet.',
    titles: {
      Sales: 'Counter Agent', Inventory: 'Warehouse Agent',
      Logistics: 'Delivery Agent', Production: 'Cutting Agent',
      Payments: 'Credit Agent',
    },
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
    key: 'repair',
    label: 'Appliance and gadget repair',
    blurb: 'Units in, diagnosis, parts, units out.',
    titles: {
      Sales: 'Intake Agent', Production: 'Bench Technician',
      Inventory: 'Parts Agent', Logistics: 'Pickup Agent',
      CRM: 'Status Agent', Payments: 'Billing Agent',
    },
  },
  {
    key: 'automotive',
    label: 'Automotive shop',
    blurb: 'Bookings, bays and parts, with a vehicle history behind each one.',
    titles: {
      Sales: 'Service Advisor', Production: 'Bay Supervisor',
      Inventory: 'Parts Agent', Logistics: 'Towing Dispatcher',
      CRM: 'Service Reminders Agent', Security: 'Shop Safety Agent',
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
    key: 'clinic',
    label: 'Clinic and dental',
    blurb: 'Appointments, recalls and records that stay private.',
    titles: {
      Secretary: 'Records Clerk',
      Sales: 'Scheduling Agent', CRM: 'Patient Care Agent',
      Production: 'Clinical Agent', Inventory: 'Supplies Agent',
      Payments: 'Billing Agent', Security: 'Records Agent',
      Admin: 'Records Admin',
    },
  },
  {
    key: 'pharmacy',
    label: 'Pharmacy and medical supply',
    blurb: 'Stock with expiry dates and rules about what may be sold.',
    titles: {
      Secretary: 'Records Clerk',
      Sales: 'Counter Agent', Inventory: 'Stock and Expiry Agent',
      Production: 'Dispensing Agent', Security: 'Compliance Agent',
      Logistics: 'Delivery Agent', Admin: 'Licensing Agent',
    },
  },
  {
    key: 'education',
    label: 'Tutorial and review centre',
    blurb: 'Enrolments, schedules and a tutor for every slot.',
    titles: {
      Secretary: 'Registrar',
      Sales: 'Enrolment Agent', Marketing: 'Outreach Agent',
      Production: 'Scheduling Agent', CRM: 'Parent Liaison Agent',
      Inventory: 'Materials Agent', Payments: 'Tuition Agent',
      HR: 'Tutor Agent',
    },
  },
  {
    key: 'events',
    label: 'Events and catering',
    blurb: 'Dates, packages, suppliers and a van that has to be loaded.',
    titles: {
      Secretary: 'Coordinator',
      Sales: 'Bookings Agent', Production: 'Event Agent',
      Inventory: 'Equipment Agent', Logistics: 'Setup Agent',
      HR: 'Crew Agent', Payments: 'Deposits Agent',
    },
  },
  {
    key: 'photography',
    label: 'Photo and video services',
    blurb: 'Shoots booked, shot, edited and delivered.',
    titles: {
      Sales: 'Bookings Agent', Production: 'Editing Agent',
      Inventory: 'Gear Agent', Logistics: 'Shoot Dispatcher',
      CRM: 'Client Gallery Agent', Payments: 'Deposits Agent',
    },
  },
  {
    key: 'printing',
    label: 'Printing and signage',
    blurb: 'Artwork in, proofs out, jobs on the machine.',
    titles: {
      Sales: 'Quoting Agent', Production: 'Press Agent',
      Inventory: 'Media and Ink Agent', Logistics: 'Installation Agent',
      CRM: 'Proofing Agent',
    },
  },
  {
    key: 'laundry',
    label: 'Laundry and dry cleaning',
    blurb: 'Loads in by weight, out by claim stub.',
    titles: {
      Sales: 'Counter Agent', Production: 'Wash Agent',
      Logistics: 'Pickup and Delivery Agent', Inventory: 'Supplies Agent',
      CRM: 'Claims Agent',
    },
  },
  {
    key: 'water',
    label: 'Water refilling station',
    blurb: 'Rounds, containers and a standing order per household.',
    titles: {
      Sales: 'Orders Agent', Production: 'Refilling Agent',
      Logistics: 'Delivery Rounds Agent', Inventory: 'Container Agent',
      Security: 'Water Quality Agent', Payments: 'Collections Agent',
    },
  },
  {
    key: 'logistics',
    label: 'Logistics and delivery',
    blurb: 'Bookings, routes and proof of delivery.',
    titles: {
      Secretary: 'Records Clerk',
      Sales: 'Booking Agent', Logistics: 'Routing Agent',
      Production: 'Hub Agent', Inventory: 'Fleet Agent',
      Payments: 'Freight Billing Agent',
    },
  },
  {
    key: 'rental',
    label: 'Equipment rental',
    blurb: 'Units out on hire, due back, and checked over in between.',
    titles: {
      Sales: 'Hire Desk Agent', Inventory: 'Fleet Agent',
      Production: 'Maintenance Agent', Logistics: 'Haulage Agent',
      Payments: 'Deposits and Hire Agent', Admin: 'Contracts Agent',
    },
  },
  {
    key: 'real_estate',
    label: 'Real estate and rentals',
    blurb: 'Listings, viewings, tenants and the rent that is due.',
    titles: {
      Secretary: 'Documents Clerk',
      Sales: 'Listings Agent', Marketing: 'Listings Marketing Agent',
      CRM: 'Viewings Agent', Production: 'Property Agent',
      Payments: 'Rent Collection Agent', Admin: 'Contracts Agent',
      Inventory: 'Portfolio Agent',
    },
  },
  {
    key: 'agriculture',
    label: 'Farm and agri supply',
    blurb: 'Harvests, inputs and buyers who pay on their own schedule.',
    titles: {
      Sales: 'Buyer Agent', Production: 'Farm Agent',
      Inventory: 'Inputs Agent', Logistics: 'Haulage Agent',
      Payments: 'Settlement Agent',
    },
  },
  {
    key: 'manufacturing',
    label: 'Small manufacturing',
    blurb: 'Orders become production runs, and runs become stock.',
    titles: {
      Sales: 'Orders Agent', Production: 'Production Agent',
      Inventory: 'Raw Materials Agent', Logistics: 'Shipping Agent',
      Security: 'QA Agent', HR: 'Shift Agent',
    },
  },
  {
    key: 'cleaning',
    label: 'Cleaning and janitorial',
    blurb: 'Contracts, crews and a site that has to be covered.',
    titles: {
      Sales: 'Contracts Agent', Production: 'Operations Supervisor',
      Logistics: 'Crew Dispatcher', Inventory: 'Supplies Agent',
      HR: 'Crew Agent', Payments: 'Billing Agent',
    },
  },
  {
    key: 'security_services',
    label: 'Security agency',
    blurb: 'Posts, shifts and guards who have to be somewhere at 10pm.',
    titles: {
      Sales: 'Contracts Agent', Production: 'Detachment Agent',
      Logistics: 'Deployment Agent', HR: 'Guard Roster Agent',
      Security: 'Incident Agent', Payments: 'Billing Agent',
    },
  },
  {
    key: 'fitness',
    label: 'Gym and studio',
    blurb: 'Memberships, class slots and the ones about to lapse.',
    titles: {
      Sales: 'Membership Agent', CRM: 'Member Care Agent',
      Production: 'Class Agent', Inventory: 'Equipment Agent',
      Payments: 'Dues Agent', HR: 'Coach Agent',
    },
  },
  {
    key: 'travel',
    label: 'Travel and tours',
    blurb: 'Itineraries, bookings and suppliers in three places.',
    titles: {
      Sales: 'Bookings Agent', Production: 'Itinerary Agent',
      Logistics: 'Transfers Agent', CRM: 'Traveller Care Agent',
      Payments: 'Deposits Agent', Admin: 'Documents Agent',
    },
  },
  {
    key: 'pet',
    label: 'Pet shop and grooming',
    blurb: 'Grooming slots, livestock and feed that has a shelf life.',
    titles: {
      Sales: 'Booking Agent', Production: 'Grooming Agent',
      Inventory: 'Feed and Stock Agent', CRM: 'Pet Owner Agent',
      Security: 'Animal Welfare Agent',
    },
  },
  {
    key: 'professional_services',
    label: 'Professional services',
    blurb: 'Billable work sold by the engagement.',
    titles: {
      Secretary: 'Executive Assistant',
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
