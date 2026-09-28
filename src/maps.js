// Address verification via the Google Geocoding API. Turns a misheard
// address like "2770 Palm Tia Lane Aurora" into a real one the agent can
// read back ("2770 Pontiac Lane, Aurora, Illinois").

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const PRECISE_LOCATION_TYPES = new Set(['ROOFTOP', 'RANGE_INTERPOLATED']);

if (!GOOGLE_MAPS_API_KEY) {
  console.warn('[WARN] GOOGLE_MAPS_API_KEY is not set — addresses will not be verified.');
}

function component(result, type, which = 'long_name') {
  const c = result.address_components.find((comp) => comp.types.includes(type));
  return c ? c[which] : null;
}

// Pull "Apartment 411" / "Apt 411" / "Unit 2B" / "#5" out of what the caller said,
// in case Google doesn't return it as a separate component.
function extractUnit(rawAddress) {
  const m = rawAddress.match(/\b(?:apartment|apt\.?|unit|suite|ste\.?|#)\s*#?\s*([a-z0-9-]+)/i);
  return m ? m[1] : null;
}

/**
 * Returns one of:
 *  { status: 'found', spokenAddress, fullAddress, zip, exactMatch }
 *  { status: 'not_found', reason? }
 *  { status: 'unavailable', message }
 */
async function verifyAddress(rawAddress) {
  if (!GOOGLE_MAPS_API_KEY) {
    return { status: 'unavailable', message: 'Address lookup is not configured.' };
  }
  if (!rawAddress || !rawAddress.trim()) return { status: 'not_found' };

  const params = new URLSearchParams({
    address: rawAddress,
    key: GOOGLE_MAPS_API_KEY,
    components: 'country:US',
  });

  const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
  if (!response.ok) throw new Error(`Geocoding HTTP ${response.status}`);

  const data = await response.json();
  if (data.status === 'ZERO_RESULTS') return { status: 'not_found' };
  if (data.status !== 'OK') {
    throw new Error(`Geocoding error: ${data.status} ${data.error_message || ''}`.trim());
  }

  const result = data.results[0];
  const streetNumber = component(result, 'street_number');
  const route = component(result, 'route'); // long form, e.g. "Pontiac Lane"
  const unit = component(result, 'subpremise') || extractUnit(rawAddress);
  const city =
    component(result, 'locality') || component(result, 'sublocality') || component(result, 'postal_town');
  const state = component(result, 'administrative_area_level_1');
  const zip = component(result, 'postal_code');

  if (!streetNumber || !route) {
    return { status: 'not_found', reason: 'Only matched a general area, not a specific street address.' };
  }

  const street = `${streetNumber} ${route}${unit ? `, Apartment ${unit}` : ''}`;
  let fullAddress = result.formatted_address.replace(/, USA$/, '');
  if (unit && !fullAddress.includes(unit)) {
    fullAddress = fullAddress.replace(`${streetNumber} `, `${streetNumber} `).replace(/^([^,]+)/, `$1 #${unit}`);
  }

  return {
    status: 'found',
    spokenAddress: [street, city, state].filter(Boolean).join(', '),
    fullAddress,
    zip,
    exactMatch: !result.partial_match && PRECISE_LOCATION_TYPES.has(result.geometry.location_type),
  };
}

module.exports = { verifyAddress };