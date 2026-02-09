// api/weather.js
// Multi-day weather forecast for entire stay (up to 7 days)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const GOOGLE_WEATHER_API_KEY = process.env.GOOGLE_WEATHER_API_KEY;

    if (!GOOGLE_WEATHER_API_KEY) {
      throw new Error('API key not configured');
    }

    const { 
      check_in_date,
      check_out_date,
      property_latitude,
      property_longitude,
      property_address,
      property_city,
      property_state,
      property_zip_code,
      property_name,
      property_id
    } = req.body;

    // Validate required fields
    if (!check_in_date || !check_out_date) {
      console.warn('Missing check_in_date or check_out_date');
      return res.json(getFallbackWeather(check_in_date, check_out_date, property_city));
    }

    // Get coordinates
    let latitude = property_latitude;
    let longitude = property_longitude;

    // If no coordinates, geocode the address
    if (!latitude || !longitude) {
      console.log(`Geocoding property ${property_id}`);
      
      let addressString = '';
      if (property_address) {
        addressString = property_address;
      } else if (property_city && property_state) {
        addressString = `${property_city}, ${property_state}`;
      } else if (property_city) {
        addressString = property_city;
      }

      if (property_zip_code && !addressString.includes(property_zip_code)) {
        addressString += ` ${property_zip_code}`;
      }

      if (!addressString) {
        return res.json(getFallbackWeather(check_in_date, check_out_date, property_city));
      }

      const geocodeUrl = new URL('https://maps.googleapis.com/maps/api/geocode/json');
      geocodeUrl.searchParams.append('address', addressString);
      geocodeUrl.searchParams.append('key', GOOGLE_WEATHER_API_KEY);

      const geocodeResponse = await fetch(geocodeUrl.toString());
      const geocodeData = await geocodeResponse.json();

      if (geocodeData.status !== 'OK' || !geocodeData.results?.[0]) {
        return res.json(getFallbackWeather(check_in_date, check_out_date, property_city));
      }

      latitude = geocodeData.results[0].geometry.location.lat;
      longitude = geocodeData.results[0].geometry.location.lng;
    }

    // Calculate dates
    const checkinDate = new Date(check_in_date);
    const checkoutDate = new Date(check_out_date);
    const today = new Date();
    
    const daysUntilCheckin = Math.ceil((checkinDate - today) / (1000 * 60 * 60 * 24));
    const numberOfNights = Math.ceil((checkoutDate - checkinDate) / (1000 * 60 * 60 * 24));
    const daysToShow = Math.min(numberOfNights, 7); // Cap at 7 days

    // Fetch weather from Google Weather API
    const weatherUrl = new URL('https://weather.googleapis.com/v1/forecast');
    weatherUrl.searchParams.append('key', GOOGLE_WEATHER_API_KEY);
    weatherUrl.searchParams.append('location', `${latitude},${longitude}`);
    weatherUrl.searchParams.append('units', 'imperial');

    const weatherResponse = await fetch(weatherUrl.toString());
    
    if (!weatherResponse.ok) {
      throw new Error(`Weather API error: ${weatherResponse.status}`);
    }

    const weatherData = await weatherResponse.json();
    const allForecasts = weatherData.daily || weatherData.forecast?.daily || [];

    // Build daily forecast array
    const dailyForecasts = [];
    
    for (let i = 0; i < daysToShow; i++) {
      const currentDate = new Date(checkinDate);
      currentDate.setDate(currentDate.getDate() + i);
      
      const dayForecast = allForecasts.find(day => {
        const forecastDate = new Date(day.date || day.time);
        return forecastDate.toDateString() === currentDate.toDateString();
      });

      if (dayForecast) {
        const temp = dayForecast.temperature || dayForecast.temp || {};
        const condition = dayForecast.condition || dayForecast.weather?.[0] || {};
        const precip = dayForecast.precipitation || dayForecast.rain || {};

        const tempHigh = Math.round(temp.high || temp.max || 75);
        const tempLow = Math.round(temp.low || temp.min || 60);
        const precipChance = Math.round((precip.probability || precip.chance || 0) * 100);

        dailyForecasts.push({
          date: currentDate.toISOString().split('T')[0],
          day_name: currentDate.toLocaleDateString('en-US', { weekday: 'long' }),
          day_short: currentDate.toLocaleDateString('en-US', { weekday: 'short' }),
          month_day: currentDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          is_checkin: i === 0,
          is_checkout: i === daysToShow - 1,
          temp_high: tempHigh,
          temp_low: tempLow,
          condition: condition.description || condition.main || 'Partly Cloudy',
          condition_simple: simplifyCondition(condition.description || condition.main || 'Partly Cloudy'),
          precipitation_chance: precipChance,
          icon_url: condition.icon_url || condition.icon || ''
        });
      }
    }

    if (dailyForecasts.length === 0) {
      return res.json(getFallbackWeather(check_in_date, check_out_date, property_city));
    }

    // Calculate summary stats
    const tempHighs = dailyForecasts.map(d => d.temp_high);
    const tempLows = dailyForecasts.map(d => d.temp_low);
    const precipChances = dailyForecasts.map(d => d.precipitation_chance);
    
    const avgHigh = Math.round(tempHighs.reduce((a, b) => a + b, 0) / tempHighs.length);
    const avgLow = Math.round(tempLows.reduce((a, b) => a + b, 0) / tempLows.length);
    const maxHigh = Math.max(...tempHighs);
    const minLow = Math.min(...tempLows);
    const avgPrecip = Math.round(precipChances.reduce((a, b) => a + b, 0) / precipChances.length);
    
    // Check if any rain/snow days
    const rainyDays = dailyForecasts.filter(d => d.precipitation_chance > 40).length;
    const hasRain = rainyDays > 0;

    // Response
    const response = {
      success: true,
      show_weather: true,
      
      // Summary
      summary: generateSummary(dailyForecasts, avgHigh, avgLow, avgPrecip, numberOfNights, property_city),
      
      // Daily forecasts
      daily_forecasts: dailyForecasts,
      
      // Packing recommendations
      packing_recommendations: generatePackingList(maxHigh, minLow, avgPrecip, dailyForecasts),
      
      // Stats
      stats: {
        check_in_date: check_in_date,
        check_out_date: check_out_date,
        days_until_checkin: daysUntilCheckin,
        number_of_nights: numberOfNights,
        days_showing: daysToShow,
        avg_high: avgHigh,
        avg_low: avgLow,
        max_high: maxHigh,
        min_low: minLow,
        avg_precipitation: avgPrecip,
        rainy_days: rainyDays,
        has_rain: hasRain
      },
      
      // Location
      location: {
        city: property_city || 'your destination',
        state: property_state || '',
        name: property_name || '',
        id: property_id
      }
    };

    console.log('Weather success:', { property_id, days: dailyForecasts.length });
    return res.json(response);

  } catch (error) {
    console.error('Weather error:', error.message);
    return res.json(getFallbackWeather(
      req.body.check_in_date,
      req.body.check_out_date,
      req.body.property_city
    ));
  }
}

// Simplify weather conditions to main types
function simplifyCondition(condition) {
  const lower = condition.toLowerCase();
  
  if (lower.includes('rain') || lower.includes('drizzle') || lower.includes('shower')) {
    return 'Rainy';
  }
  if (lower.includes('snow') || lower.includes('sleet') || lower.includes('ice')) {
    return 'Snow';
  }
  if (lower.includes('thunder') || lower.includes('storm')) {
    return 'Stormy';
  }
  if (lower.includes('cloud') || lower.includes('overcast')) {
    return 'Cloudy';
  }
  if (lower.includes('clear') || lower.includes('sunny')) {
    return 'Sunny';
  }
  if (lower.includes('partly') || lower.includes('mostly')) {
    return 'Partly Cloudy';
  }
  if (lower.includes('fog') || lower.includes('mist') || lower.includes('haze')) {
    return 'Foggy';
  }
  
  return 'Partly Cloudy';
}

// Generate overall summary
function generateSummary(forecasts, avgHigh, avgLow, avgPrecip, nights, city) {
  const conditions = forecasts.map(f => f.condition_simple);
  const uniqueConditions = [...new Set(conditions)];
  
  let summary = `The weather for your ${nights}-night stay in ${city} will be `;
  
  // Describe overall conditions
  if (uniqueConditions.length === 1) {
    summary += `${uniqueConditions[0].toLowerCase()}`;
  } else if (avgPrecip > 50) {
    summary += 'mostly rainy';
  } else if (avgPrecip > 30) {
    summary += 'mixed with some rain';
  } else {
    summary += 'pleasant';
  }
  
  // Add temperature range
  summary += ` with temperatures ranging from ${avgLow}°F to ${avgHigh}°F.`;
  
  return summary;
}

// Generate packing list
function generatePackingList(maxHigh, minLow, avgPrecip, forecasts) {
  const items = [];
  
  // Temperature-based
  if (maxHigh > 85) {
    items.push('Light, breathable clothing');
    items.push('Sunscreen and sunglasses');
    items.push('Hat for sun protection');
  } else if (maxHigh > 75) {
    items.push('Summer clothing');
    items.push('Sunscreen');
  } else if (maxHigh > 65) {
    items.push('Light layers');
  } else if (maxHigh < 60) {
    items.push('Warm clothing');
    items.push('Jacket or coat');
  }
  
  // Cold evenings
  if (minLow < 60) {
    items.push('Warm layers for evenings');
  }
  
  // Temperature variation
  const tempRange = maxHigh - minLow;
  if (tempRange > 25) {
    items.push('Versatile layers for temperature changes');
  }
  
  // Rain/precipitation
  if (avgPrecip > 60) {
    items.push('Rain jacket');
    items.push('Waterproof shoes');
    items.push('Umbrella');
  } else if (avgPrecip > 30) {
    items.push('Rain jacket or umbrella');
  }
  
  // Check for snow
  const hasSnow = forecasts.some(f => f.condition_simple === 'Snow');
  if (hasSnow) {
    items.push('Winter boots');
    items.push('Warm winter coat');
  }
  
  // Remove duplicates and limit to top 5
  const uniqueItems = [...new Set(items)];
  return uniqueItems.slice(0, 5);
}

// Fallback
function getFallbackWeather(checkInDate, checkOutDate, city) {
  return {
    success: false,
    show_weather: false,
    summary: `We hope you have wonderful weather during your stay${city ? ' in ' + city : ''}!`,
    packing_recommendations: ['Pack comfortable clothes', 'Check local forecast before departure'],
    stats: {
      check_in_date: checkInDate,
      check_out_date: checkOutDate
    },
    fallback: true
  };
}
---
