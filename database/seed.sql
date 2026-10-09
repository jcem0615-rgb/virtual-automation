-- Virtual Office — seed data.
-- Two demo businesses, nine agents each (one per department).
-- Idempotent: re-running refreshes names and desk positions but never touches
-- a live `status`, so you can reseed a running office safely.

INSERT INTO businesses (code, name, business_type, timezone, currency) VALUES
  ('BIZ_ELEC',  'Elecfix Electrical Services', 'electrical',  'Asia/Manila', 'PHP'),
  ('BIZ_ITSOL', 'ITSol Managed IT',            'it_services', 'Asia/Manila', 'PHP')
ON CONFLICT (code) DO UPDATE
  SET name = EXCLUDED.name,
      business_type = EXCLUDED.business_type,
      timezone = EXCLUDED.timezone,
      currency = EXCLUDED.currency;

-- The desks themselves come from provision_business_agents(), the same
-- function the platform portal calls, so every floor is laid out alike.
SELECT provision_business_agents(id) FROM businesses WHERE code IN ('BIZ_ELEC', 'BIZ_ITSOL');

-- Then give the demo staff names, so the two offices do not read identically.
WITH roster (business_code, department, name) AS (
  VALUES
    ('BIZ_ELEC', 'Sales',      'Rhea Delgado'),
    ('BIZ_ELEC', 'Marketing',  'Ysabel Cruz'),
    ('BIZ_ELEC', 'CRM',        'Dante Rivera'),
    ('BIZ_ELEC', 'Inventory',  'Marco Villamor'),
    ('BIZ_ELEC', 'HR',         'Liza Mendoza'),
    ('BIZ_ELEC', 'Admin',      'Noel Bautista'),
    ('BIZ_ELEC', 'Logistics',  'Kiko Arellano'),
    ('BIZ_ELEC', 'Security',   'Pia Tolentino'),
    ('BIZ_ELEC', 'Production', 'Ramon Guzman'),
    ('BIZ_ITSOL', 'Sales',      'Jonas Salcedo'),
    ('BIZ_ITSOL', 'Marketing',  'Trina Lazaro'),
    ('BIZ_ITSOL', 'CRM',        'Bea Sandoval'),
    ('BIZ_ITSOL', 'Inventory',  'Ernie Pascual'),
    ('BIZ_ITSOL', 'HR',         'Carmi Jover'),
    ('BIZ_ITSOL', 'Admin',      'Teddy Ocampo'),
    ('BIZ_ITSOL', 'Logistics',  'Val Dizon'),
    ('BIZ_ITSOL', 'Security',   'Gail Fortich'),
    ('BIZ_ITSOL', 'Production', 'Ivan Mercado')
)
UPDATE agents a
   SET name = r.name
  FROM roster r
  JOIN businesses b ON b.code = r.business_code
 WHERE a.business_id = b.id AND a.department = r.department;

-- ITSol is an IT shop, so a couple of its desks are called something else.
UPDATE agents a SET role_title = v.role_title
  FROM (VALUES
    ('Sales', 'Account Executive'),
    ('Marketing', 'Demand Gen Agent'),
    ('CRM', 'Client Success Agent'),
    ('Inventory', 'Asset Agent'),
    ('Logistics', 'Deployment Agent'),
    ('Security', 'SecOps Agent'),
    ('Production', 'Service Desk Agent')
  ) AS v (department, role_title)
 WHERE a.department = v.department
   AND a.business_id = (SELECT id FROM businesses WHERE code = 'BIZ_ITSOL');
