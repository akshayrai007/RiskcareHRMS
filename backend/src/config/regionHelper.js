// regionHelper.js — Single source of truth for India state/UT → holiday region
// region = 'north'      → Delhi holiday list (15 holidays)
// region = 'south_west' → Mumbai holiday list (15 holidays)
//
// ALL 28 STATES + 8 UNION TERRITORIES covered
//
// NORTH region:
//   States: Delhi, UP, Uttarakhand, Haryana, Punjab, Rajasthan, Bihar,
//           Madhya Pradesh, Himachal Pradesh, Jammu & Kashmir, Ladakh,
//           Jharkhand, Chhattisgarh, West Bengal, Assam, Meghalaya,
//           Manipur, Mizoram, Nagaland, Tripura, Arunachal Pradesh, Sikkim
//   UTs:    Chandigarh, Dadra & Nagar Haveli (north border), Lakshadweep (disputed — defaulting north)
//
// SOUTH_WEST region:
//   States: Maharashtra, Karnataka, Tamil Nadu, Andhra Pradesh, Telangana,
//           Kerala, Gujarat, Goa, Odisha
//   UTs:    Puducherry, Daman & Diu, Lakshadweep, Andaman & Nicobar

const NORTH_INDIA_KEYWORDS = [
  // ── STATES ──────────────────────────────────────────────────
  // Delhi
  'delhi', 'new delhi',
  // Uttar Pradesh
  'uttar pradesh', 'up', 'lucknow', 'kanpur', 'agra', 'varanasi', 'allahabad', 'prayagraj', 'meerut', 'noida', 'ghaziabad',
  // Uttarakhand
  'uttarakhand', 'uttaranchal', 'dehradun', 'haridwar', 'rishikesh', 'nainital',
  // Haryana
  'haryana', 'gurugram', 'gurgaon', 'faridabad', 'panipat', 'ambala', 'hisar', 'rohtak',
  // Punjab
  'punjab', 'amritsar', 'ludhiana', 'jalandhar', 'patiala', 'mohali',
  // Rajasthan
  'rajasthan', 'jaipur', 'jodhpur', 'udaipur', 'kota', 'ajmer', 'bikaner',
  // Bihar
  'bihar', 'patna', 'gaya', 'muzaffarpur', 'bhagalpur',
  // Madhya Pradesh
  'madhya pradesh', 'mp', 'bhopal', 'indore', 'jabalpur', 'gwalior', 'ujjain',
  // Himachal Pradesh
  'himachal pradesh', 'himachal', 'shimla', 'manali', 'dharamshala', 'kullu',
  // Jammu & Kashmir
  'jammu', 'kashmir', 'srinagar', 'j&k', 'j & k',
  // Ladakh (UT)
  'ladakh', 'leh', 'kargil',
  // Jharkhand
  'jharkhand', 'ranchi', 'jamshedpur', 'dhanbad', 'bokaro',
  // Chhattisgarh
  'chhattisgarh', 'raipur', 'bilaspur', 'durg', 'bhilai',
  // West Bengal
  'west bengal', 'bengal', 'kolkata', 'calcutta', 'howrah', 'durgapur', 'asansol', 'siliguri',
  // Assam
  'assam', 'guwahati', 'dispur', 'silchar', 'dibrugarh',
  // Meghalaya
  'meghalaya', 'shillong',
  // Manipur
  'manipur', 'imphal',
  // Mizoram
  'mizoram', 'aizawl',
  // Nagaland
  'nagaland', 'kohima', 'dimapur',
  // Tripura
  'tripura', 'agartala',
  // Arunachal Pradesh
  'arunachal pradesh', 'arunachal', 'itanagar',
  // Sikkim
  'sikkim', 'gangtok',
  // Odisha (shares more culture with east/north India — gets north list)
  'odisha', 'orissa', 'bhubaneswar', 'cuttack', 'rourkela', 'berhampur',

  // ── UNION TERRITORIES (North) ────────────────────────────────
  // Chandigarh
  'chandigarh',
  // Dadra & Nagar Haveli and Daman & Diu (northern border UT)
  'dadra', 'nagar haveli',
  // Delhi UTs already covered above
];

const SOUTH_WEST_INDIA_KEYWORDS = [
  // ── STATES ──────────────────────────────────────────────────
  // Maharashtra
  'maharashtra', 'mumbai', 'pune', 'nagpur', 'nashik', 'aurangabad', 'thane', 'navi mumbai',
  // Karnataka
  'karnataka', 'bangalore', 'bengaluru', 'mysore', 'mysuru', 'hubli', 'mangalore', 'belgaum',
  // Tamil Nadu
  'tamil nadu', 'tamilnadu', 'chennai', 'madras', 'coimbatore', 'madurai', 'tiruchirappalli',
  // Andhra Pradesh
  'andhra pradesh', 'andhra', 'hyderabad', 'visakhapatnam', 'vizag', 'vijayawada', 'tirupati', 'amaravati',
  // Telangana
  'telangana', 'secunderabad', 'warangal',
  // Kerala
  'kerala', 'thiruvananthapuram', 'trivandrum', 'kochi', 'cochin', 'kozhikode', 'calicut', 'thrissur', 'kollam',
  // Gujarat
  'gujarat', 'ahmedabad', 'surat', 'vadodara', 'baroda', 'rajkot', 'gandhinagar',
  // Goa
  'goa', 'panaji', 'margao', 'vasco',

  // ── UNION TERRITORIES (South/West) ──────────────────────────
  // Puducherry
  'puducherry', 'pondicherry',
  // Daman & Diu
  'daman', 'diu',
  // Andaman & Nicobar
  'andaman', 'nicobar', 'port blair',
  // Lakshadweep
  'lakshadweep', 'kavaratti',
];

/**
 * Determine holiday region for an employee based on their city/state.
 * Checks north keywords first — if no match, defaults to south_west.
 * @param {string} city  - e.g. 'Delhi', 'Mumbai', 'Kolkata', 'Kochi'
 * @param {string} state - e.g. 'West Bengal', 'Kerala', 'Jammu'
 * @returns {'north' | 'south_west'}
 */
function getEmployeeRegion(city = '', state = '') {
  const haystack = `${city} ${state}`.toLowerCase().trim();
  if (!haystack) return 'south_west'; // default fallback
  const isNorth = NORTH_INDIA_KEYWORDS.some(kw => haystack.includes(kw));
  return isNorth ? 'north' : 'south_west';
}

module.exports = { getEmployeeRegion, NORTH_INDIA_KEYWORDS, SOUTH_WEST_INDIA_KEYWORDS };
