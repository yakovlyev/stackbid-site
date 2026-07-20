// Оценка стоимости труда — отдельно от материалов, честная вилка, не точная цифра.
// Источник почасовых ставок: labor_rates (BLS OEWS May 2025, региональная надбавка).
// Источник часов на проект: отраслевые ориентиры (не BLS, размечено явно как оценка).
exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin': 'https://stackbid.app', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  try {
    const { project_type, zip } = JSON.parse(event.body || '{}');
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

    // Первая цифра ZIP → регион US Census. Общеизвестное грубое соответствие
    // (используется USPS для маршрутизации почты), не претендует на точность
    // до штата — этого достаточно для вилки, не для точной цифры.
    const firstDigit = (zip || '').trim()[0];
    const regionMap = {
      '0': 'northeast', '1': 'northeast',
      '2': 'south', '3': 'south', '7': 'south',
      '4': 'midwest', '5': 'midwest', '6': 'midwest',
      '8': 'west', '9': 'west',
    };
    const region = regionMap[firstDigit] || 'national';

    // Тип проекта → (специальность, диапазон часов). Диапазоны часов — отраслевые
    // ориентиры для типового проекта такого рода, НЕ из BLS — размечено отдельно
    // в ответе, чтобы фронтенд мог честно объяснить это пользователю.
    const PROJECT_MAP = {
      'New home build':        { trade: 'general_labor', hoursLow: 800, hoursHigh: 1600 },
      'Garage door replacement': { trade: 'carpentry', hoursLow: 4, hoursHigh: 10 },
      'Deck or patio':         { trade: 'carpentry', hoursLow: 40, hoursHigh: 80 },
      'Deck / patio':          { trade: 'carpentry', hoursLow: 40, hoursHigh: 80 },
      'Fence':                 { trade: 'carpentry', hoursLow: 16, hoursHigh: 40 },
      'Roofing replacement':   { trade: 'roofing', hoursLow: 24, hoursHigh: 48 },
      'Roofing':                { trade: 'roofing', hoursLow: 24, hoursHigh: 48 },
      'Siding or facade':      { trade: 'carpentry', hoursLow: 40, hoursHigh: 80 },
      'Siding':                 { trade: 'carpentry', hoursLow: 40, hoursHigh: 80 },
      'Foundation':            { trade: 'masonry', hoursLow: 60, hoursHigh: 120 },
      'Interior remodel':      { trade: 'carpentry', hoursLow: 60, hoursHigh: 120 },
      'Flooring':              { trade: 'flooring', hoursLow: 16, hoursHigh: 40 },
      'Drywall':               { trade: 'drywall', hoursLow: 16, hoursHigh: 32 },
      'Concrete':              { trade: 'masonry', hoursLow: 24, hoursHigh: 48 },
    };
    const mapping = PROJECT_MAP[project_type] || { trade: 'general_labor', hoursLow: 24, hoursHigh: 60 };

    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/labor_rates?trade=eq.${mapping.trade}&region=eq.${region}&select=hourly_rate_low,hourly_rate_high,source`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await r.json();
    const rate = rows && rows[0];
    if (!rate) {
      return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ available: false }) };
    }

    const laborLow = Math.round(rate.hourly_rate_low * mapping.hoursLow);
    const laborHigh = Math.round(rate.hourly_rate_high * mapping.hoursHigh);

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        available: true,
        trade: mapping.trade,
        region,
        hourly_rate_low: rate.hourly_rate_low,
        hourly_rate_high: rate.hourly_rate_high,
        hours_low: mapping.hoursLow,
        hours_high: mapping.hoursHigh,
        labor_low: laborLow,
        labor_high: laborHigh,
        wage_source: rate.source,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': 'https://stackbid.app', 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};
