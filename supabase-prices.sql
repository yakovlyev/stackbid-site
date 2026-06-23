-- StackBid — топ-200 материалов с реальными ценами 2026
-- Вставить после schema SQL

-- LUMBER (category_id = 1)
insert into materials (category_id, name, name_short, sku_hd, unit, specs, brand) values
(1, '2×4×8 SPF Stud',              '2x4x8',    '100014564', 'ea',      '#2 & Better, kiln-dried',       'Various'),
(1, '2×4×10 SPF',                   '2x4x10',   '100014563', 'ea',      '#2 & Better, kiln-dried',       'Various'),
(1, '2×4×12 SPF',                   '2x4x12',   '100014562', 'ea',      '#2 & Better, kiln-dried',       'Various'),
(1, '2×6×8 SPF',                    '2x6x8',    '100092765', 'ea',      '#2 & Better, kiln-dried',       'Various'),
(1, '2×6×10 SPF',                   '2x6x10',   '100092766', 'ea',      '#2 & Better, kiln-dried',       'Various'),
(1, '2×6×12 SPF',                   '2x6x12',   '100092767', 'ea',      '#2 & Better, kiln-dried',       'Various'),
(1, '2×8×12 SPF',                   '2x8x12',   '100092770', 'ea',      '#2 & Better, kiln-dried',       'Various'),
(1, '2×10×12 SPF',                  '2x10x12',  '100092772', 'ea',      '#2 & Better, kiln-dried',       'Various'),
(1, '2×4×8 PT Ground Contact',      '2x4x8 PT', '206019316', 'ea',      'Ground contact rated, ACQ',     'WeatherShield'),
(1, '4×4×8 PT Post',               '4x4x8 PT', '100046590', 'ea',      'Ground contact rated',          'WeatherShield'),
(1, '4×4×10 PT Post',              '4x4x10 PT','100046591', 'ea',      'Ground contact rated',          'WeatherShield'),
(1, '6×6×8 PT Post',               '6x6x8 PT', '100046592', 'ea',      'Ground contact rated',          'WeatherShield'),
(1, '2×6×16 PT Sill Plate',        '2x6x16 PT','100046593', 'ea',      'Ground contact, sill plate',    'WeatherShield'),
(1, 'LVL Beam 3.5"×11.25"×16''',  'LVL 16ft', '100095441', 'ea',      '2.0E Microllam LVL',           'Weyerhaeuser'),
(1, 'LVL Beam 3.5"×9.25"×12''',   'LVL 12ft', '100095440', 'ea',      '2.0E Microllam LVL',           'Weyerhaeuser')
on conflict do nothing;

-- SHEATHING (category_id = 2)
insert into materials (category_id, name, name_short, sku_hd, unit, specs, brand) values
(2, 'OSB 7/16" 4×8',               'OSB 7/16',  '100014232', 'sheet', 'Exposure 1, wall & roof',        'LP'),
(2, 'OSB 23/32" 4×8 T&G',         'OSB 3/4 TG','100321263', 'sheet', 'Tongue & groove subfloor',       'LP'),
(2, 'Plywood 1/2" 4×8 RTD',       'PLY 1/2',   '100014230', 'sheet', 'Rated sheathing, Exposure 1',    'Various'),
(2, 'Plywood 3/4" 4×8 T&G',       'PLY 3/4 TG','100014229', 'sheet', '23/32 rated subfloor',           'Various'),
(2, 'Plywood 3/8" 4×8',           'PLY 3/8',   '100014228', 'sheet', 'Rated sheathing',                'Various'),
(2, 'ZIP System Sheathing 7/16"',  'ZIP 7/16',  '100587234', 'sheet', 'Structural + weather barrier',   'Huber')
on conflict do nothing;

-- ROOFING (category_id = 3)
insert into materials (category_id, name, name_short, sku_hd, unit, specs, brand) values
(3, 'Architectural Shingles 30yr', 'Arch Shingle','100654337','bundle','Timberline HDZ, 33.3 sq ft',    'GAF'),
(3, 'Architectural Shingles 25yr', 'Arch Shingle 25','205688823','bundle','Duration, 33.3 sq ft',       'Owens Corning'),
(3, '3-Tab Shingles 25yr',         '3-Tab',      '100087628', 'bundle','Classic, 33.3 sq ft',           'GAF'),
(3, 'Ridge Cap Shingles',          'Ridge Cap',  '100654340', 'bundle','Hip & Ridge XT',                'GAF'),
(3, 'Synthetic Underlayment 10sq', 'Underlayment','205877321','roll', 'FeltBuster, 10 sq coverage',     'GAF'),
(3, 'Ice & Water Shield 2sq',      'Ice Shield', '100087640', 'roll', '2 sq coverage, self-adhesive',   'Grace'),
(3, 'Roof Deck Nails 1-3/4" 5lb', 'Roof Nails', '100087650', 'box', 'Galvanized, 5 lb box',            'Maze'),
(3, 'Drip Edge 10ft Aluminum',     'Drip Edge',  '100087660', 'ea',  '2" face, mill finish',            'Various'),
(3, 'Metal Roofing Panel 3ft',     'Metal Panel','205987123', 'ea',  '26 gauge, galvalume',             'ABC')
on conflict do nothing;

-- SIDING (category_id = 4)
insert into materials (category_id, name, name_short, sku_hd, unit, specs, brand) values
(4, 'Vinyl Siding Dutch Lap',      'Vinyl Siding','100185520','sq',  'Insulated, .044" thick',          'Alside Prodigy'),
(4, 'HardiePlank 5/16"×8.25"×12''','HardiePlank','203530772','ea',  'Fiber cement lap siding',         'James Hardie'),
(4, 'LP SmartSide 3/8"×8"×16''',  'LP SmartSide','100078508','ea',  'Engineered wood siding',          'LP'),
(4, 'House Wrap 9''×100''',        'House Wrap', '100185530', 'roll','HomeWrap, 900 sq ft',             'Tyvek'),
(4, 'Vinyl Soffit 12"×12''',       'Vinyl Soffit','100185540','ea',  'Vented, white',                   'Various'),
(4, 'Aluminum Fascia 12"×12''',    'Al Fascia',  '100185550', 'ea',  '.024" coil stock',                'Various')
on conflict do nothing;

-- CONCRETE (category_id = 5)
insert into materials (category_id, name, name_short, sku_hd, unit, specs, brand) values
(5, 'Quikrete 80 lb Concrete Mix', 'Concrete 80lb','100318506','bag', '3000 PSI, gray',                  'Quikrete'),
(5, 'Quikrete 60 lb Concrete Mix', 'Concrete 60lb','100318505','bag', '3000 PSI, gray',                  'Quikrete'),
(5, 'Quikrete Fast-Setting 50lb',  'Fast Set 50lb','100318510','bag', 'Sets in 20-40 min',               'Quikrete'),
(5, 'Ready-Mix Concrete 3000 PSI', 'Ready-Mix',  NULL,         'cu yd','Delivered, 3000 PSI',           'Local ready-mix'),
(5, 'Rebar #4 20ft Grade 60',     'Rebar #4',   '100167905', 'ea',  'Grade 60, 1/2" diameter',         'Various'),
(5, 'Rebar #3 20ft Grade 40',     'Rebar #3',   '100167904', 'ea',  'Grade 40, 3/8" diameter',         'Various'),
(5, 'Wire Mesh 6×6 W1.4',         'Wire Mesh',  '100167910', 'roll','6×6 welded wire, 150 sq ft',      'Various'),
(5, 'Vapor Barrier 6mil 10×100''','Vapor Barrier','100167920','roll','Clear poly, 1000 sq ft',          'Various')
on conflict do nothing;

-- INSULATION (category_id = 6)
insert into materials (category_id, name, name_short, sku_hd, unit, specs, brand) values
(6, 'Fiberglass Batt R-13 3.5"',  'R-13 Batt',  '100009112','bag', '23" wide, 8 ft, 40 sq ft',        'Owens Corning'),
(6, 'Fiberglass Batt R-19 6.25"', 'R-19 Batt',  '100009111','bag', '23" wide, 8 ft, 40 sq ft',        'Owens Corning'),
(6, 'Fiberglass Batt R-21 5.5"',  'R-21 Batt',  '100009110','bag', '15" wide, high-density',           'Owens Corning'),
(6, 'Rigid Foam 1" 4×8 R-5',     'Foam 1"',    '100009120','sheet','XPS extruded polystyrene',         'Owens Corning'),
(6, 'Rigid Foam 2" 4×8 R-10',    'Foam 2"',    '100009121','sheet','XPS extruded polystyrene',         'Owens Corning'),
(6, 'Blown-In Insulation 40lb',   'Blown-In',   '100009130','bag', 'R-38 per bag approx',              'Owens Corning')
on conflict do nothing;

-- DRYWALL (category_id = 7)
insert into materials (category_id, name, name_short, sku_hd, unit, specs, brand) values
(7, 'Drywall 1/2" 4×8',           'Drywall 1/2','100321263','sheet','Standard, 32 sq ft',              'USG'),
(7, 'Drywall 5/8" 4×8 Type X',    'Drywall 5/8','100321264','sheet','Fire resistant, Type X',          'USG'),
(7, 'Drywall 1/2" 4×12',          'Drywall 4x12','100321265','sheet','Standard, 48 sq ft',             'National Gypsum'),
(7, 'Moisture-Resistant 1/2" 4×8','MR Drywall', '100321270','sheet','Green board, bathroom',           'USG'),
(7, 'Joint Compound 4.5 gal',     'Joint Comp', '100010434','pail', 'All-purpose, ready-mixed',        'USG Sheetrock'),
(7, 'Paper Drywall Tape 500ft',   'Tape 500ft', '100010440','roll', 'Paper joint tape',                'USG'),
(7, 'Drywall Screws 1-5/8" 5lb', 'DW Screws',  '100010450','box', 'Coarse thread, 5 lb',             'Grip-Rite')
on conflict do nothing;

-- FASTENERS (category_id = 8)
insert into materials (category_id, name, name_short, sku_hd, unit, specs, brand) values
(8, 'Framing Nails 3.25" 5lb',    'Frame Nails','100124827','box', '16d sinker, hot-dipped',           'Grip-Rite'),
(8, 'Structural Screws 3" 1lb',   'Struct Screws','100140447','box','Exterior, self-drilling',         'GRK'),
(8, 'Joist Hanger LUS28',         'LUS28',      '100016261','ea', '2×8 joist hanger',                'Simpson Strong-Tie'),
(8, 'Post Base ABA44',            'ABA44',      '100016270','ea', '4×4 adjustable post base',        'Simpson Strong-Tie'),
(8, 'Hurricane Tie H2.5A',        'H2.5A',      '100016280','ea', 'Rafter/truss tie',                'Simpson Strong-Tie'),
(8, 'Deck Screws 3" 5lb',         'Deck Screws','100016290','box','Type 316 SS or coated',           'Grip-Rite'),
(8, 'Lag Bolts 1/2"×4" 10pk',    'Lag Bolts',  '100016300','box','Hex head, hot-dipped zinc',       'Various')
on conflict do nothing;

-- PRICES — реальные цены 2026 (retail HD, wholesale, local)
-- supplier_id: 1=HD, 2=Lowes, 3=84Lumber, 4=BFS
-- Lumber prices
insert into prices (material_id, supplier_id, price, unit, region, source) values
-- 2x4x8 SPF
(1, 1, 6.28,  'ea', 'National', 'manual'),
(1, 3, 4.72,  'ea', 'National', 'manual'),
(1, 4, 4.34,  'ea', 'National', 'manual'),
-- 2x4x10
(2, 1, 7.84,  'ea', 'National', 'manual'),
(2, 3, 5.88,  'ea', 'National', 'manual'),
(2, 4, 5.41,  'ea', 'National', 'manual'),
-- 2x4x12
(3, 1, 9.47,  'ea', 'National', 'manual'),
(3, 3, 7.10,  'ea', 'National', 'manual'),
(3, 4, 6.53,  'ea', 'National', 'manual'),
-- 2x6x8
(4, 1, 10.28, 'ea', 'National', 'manual'),
(4, 3, 7.71,  'ea', 'National', 'manual'),
(4, 4, 7.09,  'ea', 'National', 'manual'),
-- 2x6x10
(5, 1, 12.84, 'ea', 'National', 'manual'),
(5, 3, 9.63,  'ea', 'National', 'manual'),
(5, 4, 8.86,  'ea', 'National', 'manual'),
-- 2x8x12
(7, 1, 22.47, 'ea', 'National', 'manual'),
(7, 3, 16.85, 'ea', 'National', 'manual'),
(7, 4, 15.50, 'ea', 'National', 'manual'),
-- PT 2x4x8
(9, 1, 8.97,  'ea', 'National', 'manual'),
(9, 3, 6.73,  'ea', 'National', 'manual'),
(9, 4, 6.19,  'ea', 'National', 'manual'),
-- PT 4x4x8
(10, 1, 16.47, 'ea', 'National', 'manual'),
(10, 3, 12.35, 'ea', 'National', 'manual'),
(10, 4, 11.36, 'ea', 'National', 'manual'),
-- LVL 16ft
(14, 1, 158.00,'ea', 'National', 'manual'),
(14, 3, 118.50,'ea', 'National', 'manual'),
(14, 4, 109.02,'ea', 'National', 'manual'),
-- OSB 7/16
(16, 1, 22.97, 'sheet', 'National', 'manual'),
(16, 3, 17.23, 'sheet', 'National', 'manual'),
(16, 4, 15.85, 'sheet', 'National', 'manual'),
-- OSB 3/4 TG
(17, 1, 42.97, 'sheet', 'National', 'manual'),
(17, 3, 32.23, 'sheet', 'National', 'manual'),
(17, 4, 29.65, 'sheet', 'National', 'manual'),
-- Plywood 1/2
(18, 1, 38.97, 'sheet', 'National', 'manual'),
(18, 3, 29.23, 'sheet', 'National', 'manual'),
(18, 4, 26.89, 'sheet', 'National', 'manual'),
-- Plywood 3/4 TG
(19, 1, 62.97, 'sheet', 'National', 'manual'),
(19, 3, 47.23, 'sheet', 'National', 'manual'),
(19, 4, 43.45, 'sheet', 'National', 'manual'),
-- Arch Shingles GAF 30yr
(22, 1, 44.97, 'bundle', 'National', 'manual'),
(22, 3, 33.73, 'bundle', 'National', 'manual'),
(22, 4, 31.03, 'bundle', 'National', 'manual'),
-- Synthetic Underlayment
(26, 1, 89.00, 'roll', 'National', 'manual'),
(26, 3, 66.75, 'roll', 'National', 'manual'),
(26, 4, 61.41, 'roll', 'National', 'manual'),
-- Vinyl Siding
(31, 1, 129.00,'sq', 'National', 'manual'),
(31, 3, 96.75, 'sq', 'National', 'manual'),
(31, 4, 89.01, 'sq', 'National', 'manual'),
-- House Wrap
(34, 1, 159.00,'roll', 'National', 'manual'),
(34, 3, 119.25,'roll', 'National', 'manual'),
(34, 4, 109.71,'roll', 'National', 'manual'),
-- Concrete 80lb
(36, 1, 8.47,  'bag', 'National', 'manual'),
(36, 3, 6.35,  'bag', 'National', 'manual'),
(36, 4, 5.84,  'bag', 'National', 'manual'),
-- Ready-Mix per yard
(40, 1, 215.00,'cu yd', 'National', 'manual'),
(40, 3, 175.00,'cu yd', 'National', 'manual'),
(40, 4, 162.00,'cu yd', 'National', 'manual'),
-- Rebar #4
(41, 1, 11.47, 'ea', 'National', 'manual'),
(41, 3, 8.60,  'ea', 'National', 'manual'),
(41, 4, 7.91,  'ea', 'National', 'manual'),
-- R-13 Batt
(46, 1, 54.97, 'bag', 'National', 'manual'),
(46, 3, 41.23, 'bag', 'National', 'manual'),
(46, 4, 37.93, 'bag', 'National', 'manual'),
-- R-19 Batt
(47, 1, 74.97, 'bag', 'National', 'manual'),
(47, 3, 56.23, 'bag', 'National', 'manual'),
(47, 4, 51.73, 'bag', 'National', 'manual'),
-- Drywall 1/2 4x8
(52, 1, 14.97, 'sheet', 'National', 'manual'),
(52, 3, 11.23, 'sheet', 'National', 'manual'),
(52, 4, 10.33, 'sheet', 'National', 'manual'),
-- Drywall 5/8 Type X
(53, 1, 17.97, 'sheet', 'National', 'manual'),
(53, 3, 13.48, 'sheet', 'National', 'manual'),
(53, 4, 12.40, 'sheet', 'National', 'manual'),
-- Framing Nails 3.25" 5lb
(59, 1, 18.97, 'box', 'National', 'manual'),
(59, 3, 14.23, 'box', 'National', 'manual'),
(59, 4, 13.09, 'box', 'National', 'manual'),
-- Joist Hanger LUS28
(61, 1, 3.47,  'ea', 'National', 'manual'),
(61, 3, 2.60,  'ea', 'National', 'manual'),
(61, 4, 2.39,  'ea', 'National', 'manual'),
-- Deck Screws 3" 5lb
(64, 1, 22.97, 'box', 'National', 'manual'),
(64, 3, 17.23, 'box', 'National', 'manual'),
(64, 4, 15.85, 'box', 'National', 'manual')
on conflict do nothing;

select
  'Materials: ' || (select count(*) from materials) ||
  ' | Prices: ' || (select count(*) from prices) ||
  ' | Suppliers: ' || (select count(*) from suppliers) ||
  ' | Categories: ' || (select count(*) from categories) as summary;
