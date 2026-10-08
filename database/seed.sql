-- Virtual Office — seed data.
-- Two demo businesses, nine agents each (one per department).
-- Idempotent: re-running refreshes names and desk positions but never touches
-- a live `status`, so you can reseed a running office safely.

INSERT INTO businesses (code, name, timezone, currency) VALUES
  ('BIZ_ELEC',  'Elecfix Electrical Services', 'Asia/Manila', 'PHP'),
  ('BIZ_ITSOL', 'ITSol Managed IT',            'Asia/Manila', 'PHP')
ON CONFLICT (code) DO UPDATE
  SET name = EXCLUDED.name,
      timezone = EXCLUDED.timezone,
      currency = EXCLUDED.currency;

-- Desks are a 3x3 grid on the office floor; the canvas reads desk_x / desk_y.
WITH roster (business_code, department, name, role_title, sprite, desk_x, desk_y) AS (
  VALUES
    -- Elecfix Electrical Services
    ('BIZ_ELEC', 'Sales',      'Rhea Delgado',   'Sales Agent',            'staff_amber',  200, 170),
    ('BIZ_ELEC', 'Marketing',  'Ysabel Cruz',    'Marketing Agent',        'staff_rose',   480, 170),
    ('BIZ_ELEC', 'CRM',        'Dante Rivera',   'Customer Care Agent',    'staff_sky',    760, 170),
    ('BIZ_ELEC', 'Inventory',  'Marco Villamor', 'Inventory Agent',        'staff_lime',   200, 330),
    ('BIZ_ELEC', 'HR',         'Liza Mendoza',   'People Agent',           'staff_violet', 480, 330),
    ('BIZ_ELEC', 'Admin',      'Noel Bautista',  'Admin Agent',            'staff_slate',  760, 330),
    ('BIZ_ELEC', 'Logistics',  'Kiko Arellano',  'Dispatch Agent',         'staff_teal',   200, 490),
    ('BIZ_ELEC', 'Security',   'Pia Tolentino',  'Security Agent',         'staff_red',    480, 490),
    ('BIZ_ELEC', 'Production', 'Ramon Guzman',   'Field Works Agent',      'staff_orange', 760, 490),
    -- ITSol Managed IT
    ('BIZ_ITSOL', 'Sales',      'Jonas Salcedo',  'Account Executive',     'staff_amber',  200, 170),
    ('BIZ_ITSOL', 'Marketing',  'Trina Lazaro',   'Demand Gen Agent',      'staff_rose',   480, 170),
    ('BIZ_ITSOL', 'CRM',        'Bea Sandoval',   'Client Success Agent',  'staff_sky',    760, 170),
    ('BIZ_ITSOL', 'Inventory',  'Ernie Pascual',  'Asset Agent',           'staff_lime',   200, 330),
    ('BIZ_ITSOL', 'HR',         'Carmi Jover',    'People Agent',          'staff_violet', 480, 330),
    ('BIZ_ITSOL', 'Admin',      'Teddy Ocampo',   'Admin Agent',           'staff_slate',  760, 330),
    ('BIZ_ITSOL', 'Logistics',  'Val Dizon',      'Deployment Agent',      'staff_teal',   200, 490),
    ('BIZ_ITSOL', 'Security',   'Gail Fortich',   'SecOps Agent',          'staff_red',    480, 490),
    ('BIZ_ITSOL', 'Production', 'Ivan Mercado',   'Service Desk Agent',    'staff_orange', 760, 490)
)
INSERT INTO agents (business_id, department, name, role_title, avatar_sprite_key, desk_x, desk_y)
SELECT b.id, r.department, r.name, r.role_title, r.sprite, r.desk_x, r.desk_y
FROM roster r
JOIN businesses b ON b.code = r.business_code
ON CONFLICT (business_id, department) DO UPDATE
  SET name              = EXCLUDED.name,
      role_title        = EXCLUDED.role_title,
      avatar_sprite_key = EXCLUDED.avatar_sprite_key,
      desk_x            = EXCLUDED.desk_x,
      desk_y            = EXCLUDED.desk_y;
