// api/weather.js
// Vercel Serverless Function for Weather API
// Optimized to use lat/long when available, geocode as fallback

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const GOOGLE_WEATHER_API_KEY = process.env.GOOGLE_WEATHER_API_KEY;

    if (!GOOGLE_WEATHER_API_KEY) {
      throw new Error('API key not configured');
    }

    // Extract data from Customer.io webhook
    const { 
      check_in_date,
      property_latitude,
      property_longitude,
      property_address,
      property_city,
      property_state,
      property_zip_code,
      property_country,
      property_name,
      guest_email,
      property_id
    } = req.body;

    // Validate required fields
    if (!check_in_date) {
      console.warn('Missing check_in_date');
      return res.json(getFallbackWeather(check_in_date, property_city));
    }

    let latitude = property_latitude;
    let longitude = property_longitude;

    // If we don't have lat/long, geocode the address
    if (!latitude || !longitude) {
      console.log(`No coordinates for property ${property_id}, attempting geocoding`);
      
      // Build address string for geocoding
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
        console.warn('No location data available for property', property_id);
        return res.json(getFallbackWeather(check_in_date, property_city));
      }

      // Geocode the address
      const geocodeUrl = new URL('https://maps.googleapis.com/maps/api/geocode/json');
      geocodeUrl.searchParams.append('address', addressString);
      geocodeUrl.searchParams.append('key', GOOGLE_WEATHER_API_KEY);

      const geocodeResponse = await fetch(geocodeUrl.toString());
      
      if (!geocodeResponse.ok) {
        throw new Error(`Geocoding API error: ${geocodeResponse.status}`);
      }

      const geocodeData = await geocodeResponse.json();

      if (geocodeData.status !== 'OK' || !geocodeData.results?.[0]) {
        console.warn('Geocoding failed:', geocodeData.status, 'for address:', addressString);
        return res.json(getFallbackWeather(check_in_date, property_city));
      }

      const location = geocodeData.results[0].geometry.location;
      latitude = location.lat;
      longitude = location.lng;

      console.log(`Geocoded ${addressString} to: ${latitude}, ${longitude}`);
    } else {
      console.log(`Using coordinates for property ${property_id}: ${latitude}, ${longitude}`);
    }

    // Calculate days until check-in
    const today = new Date();
    const checkinDate = new Date(check_in_date);
    const daysUntilCheckin = Math.ceil((checkinDate - today) / (1000 * 60 * 60 * 24));

    // Call Google Weather API
    const weatherUrl = new URL('https://weather.googleapis.com/v1/forecast');
    weatherUrl.searchParams.append('key', GOOGLE_WEATHER_API_KEY);
    weatherUrl.searchParams.append('location', `${latitude},${longitude}`);
    weatherUrl.searchParams.append('units', 'imperial');

    const weatherResponse = await fetch(weatherUrl.toString());

    if (!weatherResponse.ok) {
      const errorText = await weatherResponse.text();
      console.error(`Weather API error ${weatherResponse.status}:`, errorText);
      throw new Error(`Weather API error: ${weatherResponse.status}`);
    }

    const weatherData = await weatherResponse.json();

    // Find forecast for check-in date
    const dailyForecasts = weatherData.daily || weatherData.forecast?.daily || [];
    
    const checkinForecast = dailyForecasts.find(day => {
      const forecastDate = new Date(day.date || day.time);
      return forecastDate.toDateString() === checkinDate.toDateString();
    });

    if (!checkinForecast) {
      console.warn(`No forecast found for check-in date ${check_in_date}`);
      return res.json(getFallbackWeather(check_in_date, property_city));
    }

    // Extract weather details (handle different API response structures)
    const temp = checkinForecast.temperature || checkinForecast.temp || {};
    const condition = checkinForecast.condition || checkinForecast.weather?.[0] || {};
    const precip = checkinForecast.precipitation || checkinForecast.rain || {};
    const wind = checkinForecast.wind || {};

    const tempHigh = Math.round(temp.high || temp.max || 75);
    const tempLow = Math.round(temp.low || temp.min || 60);
    const precipChance = Math.round((precip.probability || precip.chance || 0) * 100);

    // Format response for Customer.io
    const responseData = {
      success: true,
      show_weather: true,
      
      // Temperature
      temperature_high: tempHigh,
      temperature_low: tempLow,
      temperature_avg: Math.round((tempHigh + tempLow) / 2),
      
      // Condition
      condition: condition.description || condition.main || 'Partly Cloudy',
      condition_code: condition.code || condition.id || '',
      condition_icon_url: condition.icon_url || condition.icon || '',
      
      // Precipitation
      precipitation_chance: precipChance,
      precipitation_amount: precip.amount || 0,
      
      // Wind
      wind_speed: Math.round(wind.speed || 0),
      wind_direction: wind.direction || '',
      
      // Summary
      weather_summary: generateWeatherSummary(tempHigh, tempLow, condition.description || 'Pleasant weather', precipChance),
      
      // Packing suggestions
      packing_suggestion: getPackingSuggestion(tempHigh, tempLow, precipChance),
      
      // Date info
      check_in_date: check_in_date,
      days_until_checkin: daysUntilCheckin,
      forecast_date: checkinForecast.date || checkinForecast.time,
      
      // Location
      property_city: property_city || 'your destination',
      property_state: property_state || '',
      property_name: property_name || '',
      property_id: property_id
    };

    console.log('Weather fetch successful:', { 
      property_id, 
      property_name,
      tempHigh, 
      tempLow, 
      condition: responseData.condition,
      location: property_city 
    });

    return res.json(responseData);

  } catch (error) {
    console.error('Weather API Error:', error.message, error.stack);
    
    // Return fallback data so email still sends
    return res.json(getFallbackWeather(
      req.body.check_in_date, 
      req.body.property_city
    ));
  }
}

// Generate weather summary text
function generateWeatherSummary(high, low, condition, precipChance) {
  let summary = `${condition} with temperatures ranging from ${low}°F to ${high}°F`;
  
  if (precipChance > 60) {
    summary += `. There's a ${precipChance}% chance of rain`;
  } else if (precipChance > 30) {
    summary += ` with a slight chance of rain`;
  }
  
  return summary + '.';
}

// Generate packing suggestions based on weather
function getPackingSuggestion(high, low, precipChance) {
  const suggestions = [];
  
  // Temperature-based
  if (high > 85) {
    suggestions.push('light, breathable clothing', 'sunscreen', 'sunglasses');
  } else if (high > 75) {
    suggestions.push('comfortable summer attire', 'sunscreen');
  } else if (high > 65) {
    suggestions.push('layers for changing temperatures');
  } else if (high < 60) {
    suggestions.push('warm clothing', 'a jacket or sweater');
  }
  
  // Precipitation
  if (precipChance > 60) {
    suggestions.push('rain jacket and umbrella');
  } else if (precipChance > 30) {
    suggestions.push('an umbrella just in case');
  }
  
  // Evening temperatures
  if (low < 55) {
    suggestions.push('warm evening wear');
  }
  
  if (suggestions.length === 0) {
    return 'Pack comfortable clothes and enjoy your stay!';
  }
  
  return `Consider packing: ${suggestions.slice(0, 4).join(', ')}.`;
}

// Fallback weather data if API fails
function getFallbackWeather(checkInDate, city) {
  return {
    success: false,
    show_weather: false,
    temperature_high: 75,
    temperature_low: 60,
    condition: 'Pleasant weather expected',
    weather_summary: `We hope you have wonderful weather for your stay${city ? ' in ' + city : ''}!`,
    packing_suggestion: 'Pack comfortable clothes and check the local forecast closer to your arrival.',
    check_in_date: checkInDate,
    days_until_checkin: 3,
    fallback: true
  };
}
```

---
